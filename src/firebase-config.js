/* ═══════════════════════════════════════════════════════════════
   FIREBASE CONFIG — src/firebase-config.js
   Replace ALL placeholder values with your real Firebase credentials.
   Get them from: https://console.firebase.google.com
   Project Settings → Your apps → </> Web → firebaseConfig
   ═══════════════════════════════════════════════════════════════ */

// Exposed on window so firebase-service.js (loaded after this) can read it
window.FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAG9ZmRZkjwynOSdkmfPIQhB-rNoSqjMJg",
  authDomain:        "regent-exam-notifier.firebaseapp.com",
  projectId:         "regent-exam-notifier",
  storageBucket:     "regent-exam-notifier.firebasestorage.app",
  messagingSenderId: "568912808477",
  appId:             "1:568912808477:web:c1af725f0cdd4ade7ed4f4"
};
