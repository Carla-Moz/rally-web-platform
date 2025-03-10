import CONFIG, { demoConfig } from "../../../firebase.config"
import { produce } from "immer/dist/immer.esm";

import {
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendEmailVerification
} from "firebase/auth";
import {
  doc,
  getDoc,
  setDoc,
  getDocs,
  updateDoc,
  collection,
  onSnapshot
} from "firebase/firestore";

import initializeFirebase from "./initialize-firebase";

let auth;
let db;

async function initializeFirestoreAPIs() {
  const fb = initializeFirebase(CONFIG, (({ auth }) => {
    onAuthStateChanged(auth, change => {
      _authChangeCallbacks.forEach(callback => callback(change));
    });
  }));
  auth = fb.auth;
  db = fb.db;
}

// NOTE: this object is not to be touched.
let __STATE__ = {
  user: undefined,
  userStudies: undefined,
  onboarded: false
};

let userRef;
let firebaseUid;

function initializeUserDocument(uid) {
  userRef = doc(db, "users", uid);
  firebaseUid = uid;
}

function getUserDocument() {
  return getDoc(userRef);
}

function updateUserDocument(updates, merge = true) {
  return updateDoc(userRef, updates, { merge });
}

async function updateUserStudiesCollection(studyId, updates, merge = true) {
  const userStudyref = doc(db, "users", firebaseUid, "studies", studyId);
  await setDoc(userStudyref, updates, { merge });
}

async function getStudies() {
  const snapshot = await getDocs(collection(db, "studies"));
  return snapshot.docs.map(doc => doc.data());
}

const _stateChangeCallbacks = [];
const _authChangeCallbacks = [];

function _updateLocalState(callback) {
  __STATE__ = produce(__STATE__, callback);
  _stateChangeCallbacks.forEach(callback => callback(__STATE__));
}

async function listenForUserChanges(user) {
  // get user doc and then call onSnapshot.
  onSnapshot(doc(db, "users", user.uid), (doc) => {
    const nextState = doc.data();
    _updateLocalState((draft) => {
      draft.user = nextState;
    });
  });
}

async function listenForUserStudiesChanges(user) {
  const userStudiesRef = collection(db, "users", user.uid, "studies");

  onSnapshot(userStudiesRef, (querySnapshot) => {
    const nextState = {};

    querySnapshot.forEach((doc) => {
      const study = doc.data();
      nextState[study.studyId] = study
    })

    _updateLocalState((draft) => {
      draft.userStudies = nextState;
    });
  });

}

function listenForStudyChanges() {
  onSnapshot(collection(db, "studies"), (querySnapshot) => {
    const studies = [];
    querySnapshot.forEach(function (doc) {
      studies.push(doc.data());
    });
    _updateLocalState((draft) => {
      draft.studies = studies;
    });
  })
}

export default {
  async initialize(browser = true) {

    if (browser) {
      initializeFirestoreAPIs();
    } else {
      return;
    }

    const initialState = {};
    let userState;

    // check for an authenticated user.
    const authenticatedUser = await new Promise((resolve) => {
      onAuthStateChanged(auth, (v) => {
        resolve(v);
      });
    });
    // if the user is authenticated, then they must have a
    // document in firestore. Retrieve it and listen for any changes
    // to the firestore doc.

    if (authenticatedUser !== null) {
      initializeUserDocument(authenticatedUser.uid);
      userState = await getUserDocument();
      userState = userState.data();
      listenForUserChanges(authenticatedUser);
      listenForUserStudiesChanges(authenticatedUser);

      // FIXME more efficient to wait for studies to ask, vs. broadcasting
      this.notifyStudies(authenticatedUser);
    }

    // fetch the initial studies.
    let initialStudyState = await getStudies();

    listenForStudyChanges();

    initialState._initialized = true;

    if (userState) {
      initialState.user = userState;
    }

    if (initialStudyState) {
      initialState.studies = initialStudyState;
    }

    return initialState;
  },

  async onAuthStateChanged(callback) {
    initializeFirestoreAPIs();
    onAuthStateChanged(auth, callback);
  },

  async loginWithGoogle() {
    const provider = new GoogleAuthProvider();

    // Allow user to select which Google account to use.
    provider.setCustomParameters({ prompt: "select_account" });

    let userCredential = undefined;
    try {
      userCredential = await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("there was an error", err);
    }
    // create a new user.
    initializeUserDocument(userCredential.user.uid);
    listenForUserChanges(userCredential.user);
    listenForUserStudiesChanges(userCredential.user);

    // FIXME more efficient to wait for studies to ask, vs. broadcasting
    this.notifyStudies(userCredential.user);
  },

  async loginWithEmailAndPassword(email, password) {
    let userCredential;
    try {
      userCredential = await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      console.error("there was an error", err);
      return;
    }
    if (userCredential.user.emailVerified) {
      initializeUserDocument(userCredential.user.uid);
      listenForUserChanges(userCredential.user);
      listenForUserStudiesChanges(userCredential.user);

      // FIXME more efficient to wait for studies to ask, vs. broadcasting
      this.notifyStudies(userCredential.user);
    } else {
      console.warn("Email account not verified, sending verification email");
      await sendEmailVerification(userCredential.user);
    }
  },
  async signupWithEmailAndPassword(email, password) {
    let userCredential;
    try {
      userCredential = await createUserWithEmailAndPassword(auth, email, password);
    } catch (err) {
      console.error("there was an error", err);
      return;
    }
    console.info("Sending verification email");
    await sendEmailVerification(userCredential.user);
  },

  async notifyStudies(user) {
    // Each study needs its own token. Need to iterate over any installed+consented studies and pass them their unique token.
    for (const study of await getStudies()) {

      // FIXME use the firebase functions library instead of raw `fetch`, then we don't need to configure it ourselves.
      let functionsHost = "https://us-central1-rally-web-spike.cloudfunctions.net";
      // @ts-ignore
      if (__EMULATOR_MODE__) {
        functionsHost = "http://localhost:5001/rally-web-spike/us-central1";
      }

      const idToken = await user.getIdToken();
      const body = JSON.stringify({ studyId: study.studyId, idToken });
      const result = await fetch(`${functionsHost}/rallytoken`,
        {
          method: "POST",
          headers: { 'Content-Type': 'application/json' },
          body
        });
      const rallyToken = (await result.json()).rallyToken;
      window.dispatchEvent(
        new CustomEvent("complete-signup", { detail: { studyId: study.studyId, rallyToken } })
      );
    }
  },

  async updateOnboardedStatus(onboarded) {
    return updateUserDocument({ onboarded });
  },

  async updateStudyEnrollment(studyId, enroll) {
    const userStudies = { ...(__STATE__.userStudies || {}) };
    if (!(studyId in userStudies)) { userStudies[studyId] = {}; }
    userStudies[studyId] = { ...userStudies[studyId] };
    userStudies[studyId].enrolled = enroll;
    userStudies[studyId].studyId = studyId;
    if (enroll) {
      userStudies[studyId].joinedOn = new Date();
    }
    await updateUserStudiesCollection(studyId, userStudies[studyId]);
    return true;
  },

  async updatePlatformEnrollment(enrolled) {
    return updateUserDocument({ enrolled });
  },

  async updateDemographicSurvey(data) {
    return updateUserDocument({ demographicsData: data });
  },

  onAuthChange(callback) {
    _authChangeCallbacks.push(callback);
  },

  onNextState(callback) {
    _stateChangeCallbacks.push(callback);
  }
};