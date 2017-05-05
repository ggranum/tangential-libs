import {Injectable} from '@angular/core';

import {generatePushID, Logger, MessageBus, ResolveVoid} from '@tangential/core';
import {FirebaseProvider, FireBlanket} from '@tangential/firebase-util';
import * as firebase from 'firebase/app';
import {BehaviorSubject} from 'rxjs/BehaviorSubject';
import {Observable} from 'rxjs/Observable';
//noinspection TypeScriptPreferShortImport
import {AuthDm} from '../../media-type/doc-model/auth';
//noinspection TypeScriptPreferShortImport
import {EmailPasswordCredentials} from '../../media-type/doc-model/email-password-credentials';
import {SignInState, SignInStates} from '../../sign-in-state';
import {UserService} from '../user/user-service';
import {AuthService} from './auth-service';
import {SessionInfoCdm} from '../../media-type/cdm/session-info';
import {AuthSubject} from '../../media-type/cdm/auth-subject';
import {Auth, AuthTransform} from '../../media-type/cdm/auth';
//noinspection TypeScriptPreferShortImport
import {AuthUserDm} from '../../media-type/doc-model/auth-user';
import {AuthUser, AuthUserTransform} from '../../media-type/cdm/auth-user';
//noinspection TypeScriptPreferShortImport
import {SignInEventTransform} from '../../media-type/cdm/sign-in-event';
import EmailAuthProvider = firebase.auth.EmailAuthProvider
import {AuthSubjectTransform} from '../../media-type/cdm/auth-subject';
//noinspection TypeScriptPreferShortImport
import {AuthSettingsFirebaseRef} from '../../media-type/doc-model/auth-settings';
import {AuthSignInEventsByUserFirebaseRef, AuthSignInEventsFirebaseRef} from '../../media-type/doc-model/auth-events';
import {SignInEvent} from '@tangential/authorization-service';

interface FirebaseAuthResponse {
  uid: string
  displayName: string
  email: string
  emailVerified: boolean
  isAnonymous: boolean
  photoURL: string
}


@Injectable()
export class FirebaseAuthService extends AuthService {

  private auth: firebase.auth.Auth
  private db: firebase.database.Database
  signInStateValue: SignInState
  private authSubjectObserver: BehaviorSubject<AuthSubject>
  private authSettingsObserver: Observable<Auth>

  constructor(protected bus: MessageBus,
              private fb: FirebaseProvider,
              protected userService: UserService) {
    super(bus, userService)
    this.auth = fb.app.auth()
    this.db = this.fb.app.database()
    this.init()
  }

  private init() {
    this.authSubjectObserver = new BehaviorSubject(AuthSubject.UnknownSubject)
    this.authSettingsObserver = FireBlanket.awaitValue$(AuthSettingsFirebaseRef(this.db))
      .map(snap => snap.val())
      .map(docModel => AuthTransform.fragmentFromDocModel(docModel))
    this.auth.onAuthStateChanged((fbAuthState: FirebaseAuthResponse) => {
      this.handleAuthStateChanged(fbAuthState)
    })
    this.setSignInState(SignInStates.unknown)
  }

  private handleAuthStateChanged(firebaseAuthResponse: FirebaseAuthResponse) {
    if (this.signInStateValue === SignInStates.signingUp) {
      /* This state change will be handled by the '#createUserWithEmailAndPassword' method. */
      Logger.trace(this.bus, this, '#handleAuthStateChanged:signingUp', 'User is signing up')
    } else if (this.isSignedInResponse(firebaseAuthResponse)) {
      Logger.trace(this.bus, this, '#handleAuthStateChanged:signedIn', firebaseAuthResponse.uid, firebaseAuthResponse.email, firebaseAuthResponse.isAnonymous)
      let firebaseResponse: AuthUserDm = this.subjectFromFirebaseResponse(firebaseAuthResponse)
      this.handleUserSignedIn(firebaseResponse).then(subject => {
        Logger.trace(this.bus, this, '#handleAuthStateChanged:Subject Resolved', subject.$key, subject.email, subject.isAnonymous)
        this.setCurrentUser(subject)
      })
    } else {
      Logger.trace(this.bus, this, '#handleAuthStateChanged', 'Visitor is Guest or has signed out')
      this.setCurrentUser(AuthSubject.GuestSubject)
    }
  }

  private setCurrentUser(subject: AuthSubject):void {
    Logger.trace(this.bus, this, '#setCurrentUser', subject ? subject.$key : 'null')
    this.setSignInState(subject.signInState)
    this.authSubjectObserver.next(subject)
  }


  private isSignedInResponse(firebaseAuthResponse: FirebaseAuthResponse) {
    return firebaseAuthResponse;
  }

  public obtainAcceptLanguageHeader(): Promise<SessionInfoCdm> {
    let url = 'https://us-central1-' + this.fb.app.options['authDomain'].split('.')[0] + '.cloudfunctions.net/visitorInfoEndpoint/';
    return new Promise((resolve, reject) => {
      this.fb.app.auth().currentUser.getToken().then((token) => {
        Logger.debug(this.bus, this, '#obtainAcceptLanguageHeader', 'Sending visitor info request.');
        const req = new XMLHttpRequest();
        req.onload = () => {
          let rawHeaders = JSON.parse(req.responseText) || {}
          let sessionInfo = SessionInfoCdm.fromHeaders(rawHeaders)
          Logger.debug(this.bus, this, '#obtainAcceptLanguageHeader::onload', sessionInfo.city)
          resolve(sessionInfo)
        }
        req.onerror = (ev) => {
          Logger.error(this.bus, this, '#obtainAcceptLanguageHeader::onerror', req.statusText)
          reject(ev)
        }
        req.open('GET', url, true);
        req.setRequestHeader('Authorization', 'Bearer ' + token);
        req.send();
      });
    })
  }

  addSignInEvent(subject: AuthSubject): Promise<void> {
    let refId = generatePushID()
    let ref = AuthSignInEventsFirebaseRef(this.db).child(refId)
    let mapRef = AuthSignInEventsByUserFirebaseRef(this.db, subject.$key).child(refId)
    let event = SignInEvent.forSubject(subject)
    return FireBlanket.set(ref, SignInEventTransform.toDocModel(event)).then(() => {
      return FireBlanket.set(mapRef, event.whenMils)
    })
  }


  private setSignInState(newState: SignInState) {
    if (this.signInStateValue !== newState) {
      Logger.trace(this.bus, this, '#setSignInState', newState)
      this.signInStateValue = newState
    }
  }

  authSubject$(): Observable<AuthSubject> {
    return this.authSubjectObserver
  }

  awaitKnownAuthSubject$():Observable<AuthSubject> {
    return this.authSubjectObserver.skipWhile(subject => subject.signInState === SignInStates.unknown)
  }


  /**
   * Auth state changes - including which user is set as currentAuthUser - are handled by listening for
   * changes sent down by firebase, NOT by manually setting the currentUser here. We have to set the login state
   * here because that information can't be derived from what is supplied by firebase.
   *
   * There's some excellent arguments for dropping the sign-in-state tracking.
   *
   * @param payload
   * @param suppressUserInfoSynchronization
   * @returns {Promise<T>}
   */
  signInWithEmailAndPassword(payload: EmailPasswordCredentials, suppressUserInfoSynchronization: boolean = false): Promise<void> {
    Logger.trace(this.bus, this, '#signInWithEmailAndPassword', 'enter', payload.email)
    this.setSignInState(SignInStates.signingIn)
    const loginCfg = {
      email: payload.email,
      password: payload.password
    }
    return new Promise<void>((resolve, reject) => {
      let readyToResolve = true
      this.authSubjectObserver.skip(1).first().subscribe(() => {
        Logger.trace(this.bus, this, '#signInWithEmailAndPassword:resolving', payload.email)
        resolve(ResolveVoid)
      })
      this.auth.signInWithEmailAndPassword(loginCfg.email, loginCfg.password).catch((reason) => {
        this.setSignInState(SignInStates.signInFailed)
        reject(reason)
      })
    });
  }

  signInAnonymously(): Promise<void> {
    Logger.trace(this.bus, this, '#signInAnonymously')

    this.setSignInState(SignInStates.signingIn)
    return new Promise<void>((resolve, reject) => {
      this.auth.signInAnonymously()
        .then((fbAuthState) => {
          const userDm = this.subjectFromFirebaseResponse(fbAuthState)
          return this.userService.create(AuthUserTransform.fragmentFromDocModel(userDm, userDm.$key)).then(() => {
            Logger.trace(this.bus, this, '#signInAnonymously', 'created anonymous user')
            this.setSignInState(SignInStates.signedInAnonymous)
            resolve(ResolveVoid)
          })
        })
        .catch((reason) => {
          this.setSignInState(SignInStates.signInFailed)
          reject(reason)
        })
    });
  }

  createUserWithEmailAndPassword(payload: EmailPasswordCredentials): Promise<void> {
    this.setSignInState(SignInStates.signingUp)
    return new Promise<void>((resolve, reject) => {
      this.auth.createUserWithEmailAndPassword(payload.email, payload.password)
        .then((fbAuthState) => {
          const userDm = this.subjectFromFirebaseResponse(fbAuthState)
          return this.userService.create(AuthUserTransform.fragmentFromDocModel(userDm, userDm.$key)).then(() => {
            Logger.trace(this.bus, this, 'created user', userDm.email)
            this.handleUserSignedIn(userDm).then(hydratedUser => {
              this.setCurrentUser(hydratedUser)
              resolve(undefined)
            })
          })
        })
        .catch((reason) => {
          this.setSignInState(SignInStates.signUpFailed)
          reject(reason)
        })
    })
  }

  signOut(): Promise<void> {
    Logger.info(this.bus, this, "#signOut", this.auth.currentUser ? this.auth.currentUser.uid : '{no user}')
    if(this.signInStateValue === SignInStates.signedOut){
      throw new Error('Cannot sign out: No user is signed in.')
    }
    if(this.signInStateValue === SignInStates.signingOut){
      throw new Error('Cannot sign out: User is already signing out.')
    }
    this.setSignInState(SignInStates.signingOut)
    return new Promise<void>((resolve, reject) => {
      this.auth.signOut().then(() => {
        this.setSignInState(SignInStates.signedOut)
        resolve()
      }).catch(() => {
        this.setSignInState(this.auth.currentUser ? SignInStates.signedIn : SignInStates.signedOut)
        reject()
      })
    })
  }


  deleteAccount(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const _authUser = this.auth.currentUser
      if (_authUser) {
        this.userService.remove(_authUser.uid).then(() => {
          this.auth.currentUser.delete().then(resolve)
        }).catch((reason) => reject(reason))
      } else {
        reject('NOT_SIGNED_IN')
      }
    })
  }

  public sendResetPasswordEmail(emailAddress: string): Promise<void> {
    return <Promise<void>>this.fb.app.auth().sendPasswordResetEmail(emailAddress)
  }

  public linkAnonymousAccount(payload: EmailPasswordCredentials): Promise<void> {
    this.setSignInState(SignInStates.signingUp)
    const credential = EmailAuthProvider.credential(payload.email, payload.password);
    return <Promise<void>>this.fb.app.auth().currentUser.link(credential)
      .then((fbAuthState) => {
        Logger.trace(this.bus, this, '#linkAnonymousAccount', 'linked user', fbAuthState.uid, fbAuthState.email)
        let dm = this.subjectFromFirebaseResponse(fbAuthState)
        const newAuthUser = AuthUserTransform.fragmentFromDocModel(dm, dm.$key);
        return this.userService.update(newAuthUser).then(() => {
          Logger.trace(this.bus, this, '#linkAnonymousAccount', 'updated linked user data', newAuthUser.email)
          return this.handleUserSignedIn(newAuthUser).then(hydratedUser => {
            this.setCurrentUser(hydratedUser)
          })
        })
      })
      .catch((reason) => {
        this.setSignInState(SignInStates.signUpFailed)
        throw reason
      })
  }

  public authDocumentModel$(): Observable<AuthDm> {
    const ref = this.db.ref('/auth')
    return FireBlanket.awaitValue$(ref).map(snap => snap.val())
  }

  public authSettings$(): Observable<Auth> {
    return this.authSettingsObserver
  }



  private subjectFromFirebaseResponse(fbResponse: FirebaseAuthResponse): AuthUserDm {
    const subject: AuthUserDm = {}
    subject.$key = fbResponse.uid
    subject.displayName = fbResponse.displayName
    subject.email = fbResponse.email
    subject.emailVerified = fbResponse.emailVerified
    subject.isAnonymous = fbResponse.isAnonymous
    subject.photoURL = fbResponse.photoURL
    return subject;
  }

  private handleUserSignedIn(iamServiceAuthDm: AuthUserDm): Promise<AuthSubject> {
    return this.userService.getUser(iamServiceAuthDm.$key).then((user:AuthUser) => {
      // Questionable choice, @revisit
      let iamUser = AuthUserTransform.fragmentFromDocModel(iamServiceAuthDm)
      AuthUser.copyTo(iamUser, user)
      return this.obtainAcceptLanguageHeader().then((sessionInfo:SessionInfoCdm) => {
        const subject = AuthSubjectTransform.from(user, SignInStates.signedIn, sessionInfo)
        subject.lastSignInMils = Date.now()
        subject.lastSignInIp = sessionInfo.ipAddress
        subject.signInState = subject.isAnonymous ? SignInStates.signedInAnonymous : SignInStates.signedIn
        this.userService.update(subject).catch(e => {
          /* By not waiting for this response we can cause problems in unit tests. In real use, however, waiting is a big waste
          * of tens of milliseconds, minimum.  */
          Logger.error(this.bus, this, '#updateUserAuthData', 'Could not update user data', subject.email, e.message)
        })
        return subject
      })
    })
  }

}

