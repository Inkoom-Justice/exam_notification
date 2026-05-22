/* ═══════════════════════════════════════════════════════════════
   FIREBASE CONFIG — src/firebase-config.js
   Replace ALL placeholder values below with your actual Firebase
   project credentials from https://console.firebase.google.com
   ═══════════════════════════════════════════════════════════════ */

const FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
};

/* ── How to get these values ───────────────────────────────────
   1. Go to https://console.firebase.google.com
   2. Click "Add project" → name it "regent-exam-notifier"
   3. Project Settings (gear icon) → "Your apps" → </> Web
   4. Register app name → copy the firebaseConfig object here
   5. In Firebase console:
      - Authentication → Get Started → Enable "Email/Password"
      - Firestore Database → Create database → Start in production mode
        → choose europe-west (closest to Warsaw)
   ─────────────────────────────────────────────────────────────── */
