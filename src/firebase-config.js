/* ═══════════════════════════════════════════════════════════════
   FIREBASE CONFIG
   Replace ALL placeholder values with your actual credentials
   from https://console.firebase.google.com
   ═══════════════════════════════════════════════════════════════ */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAG9ZmRZkjwynOSdkmfPIQhB-rNoSqjMJg",
  authDomain: "regent-exam-notifier.firebaseapp.com",
  projectId: "regent-exam-notifier",
  storageBucket: "regent-exam-notifier.firebasestorage.app",
  messagingSenderId: "568912808477",
  appId: "1:568912808477:web:c1af725f0cdd4ade7ed4f4"
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
