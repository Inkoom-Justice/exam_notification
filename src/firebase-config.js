/* ═══════════════════════════════════════════════════════════════
   FIREBASE CONFIG — src/firebase-config.js
   Replace ALL placeholder values with your real Firebase credentials.
   Get them from: https://console.firebase.google.com
   Project Settings → Your apps → </> Web → firebaseConfig
   ═══════════════════════════════════════════════════════════════ */

// Exposed on window so firebase-service.js (loaded after this) can read it
window.FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
};
