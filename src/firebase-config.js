/* ═══════════════════════════════════════════════════════════════
   FIREBASE CONFIG
   Replace ALL placeholder values with your actual credentials
   from https://console.firebase.google.com
   ═══════════════════════════════════════════════════════════════ */
const FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
};

/*
  SETUP STEPS:
  1. Go to https://console.firebase.google.com
  2. Create project → name it "regent-exam-notifier"
  3. Project Settings (gear icon) → Your apps → </> Web → Register app
  4. Copy the firebaseConfig values into the object above
  5. In Firebase Console also enable:
     • Firestore Database → Create database → Production mode → europe-west region
     • Authentication → Get Started → Enable "Anonymous" sign-in method
  6. Set Firestore security rules (see README for rules to paste)
*/
