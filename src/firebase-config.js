/* ═══════════════════════════════════════════════════════════════
   FIREBASE CONFIG — src/firebase-config.js
   Replace ALL placeholder values below with your actual Firebase
   project credentials from https://console.firebase.google.com
   ═══════════════════════════════════════════════════════════════ */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAG9ZmRZkjwynOSdkmfPIQhB-rNoSqjMJg",
  authDomain: "regent-exam-notifier.firebaseapp.com",
  projectId: "regent-exam-notifier",
  storageBucket: "regent-exam-notifier.firebasestorage.app",
  messagingSenderId: "568912808477",
  appId: "1:568912808477:web:c1af725f0cdd4ade7ed4f4"
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
