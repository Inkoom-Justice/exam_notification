/* ═══════════════════════════════════════════════════════════════
   FIREBASE SERVICE LAYER — src/firebase-service.js
   Wraps all Firestore + Auth operations used by both portals.
   ═══════════════════════════════════════════════════════════════ */

import { initializeApp }                                from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword,
         signInWithEmailAndPassword, signOut,
         onAuthStateChanged, updatePassword,
         EmailAuthProvider, reauthenticateWithCredential,
         sendPasswordResetEmail }                        from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, collection, doc, getDocs,
         getDoc, setDoc, addDoc, updateDoc, deleteDoc,
         query, where, orderBy, onSnapshot,
         serverTimestamp, writeBatch, Timestamp }        from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/* ── Init ─────────────────────────────────────────────────────── */
const app = initializeApp(FIREBASE_CONFIG);   // FIREBASE_CONFIG from firebase-config.js
export const auth = getAuth(app);
export const db   = getFirestore(app);

/* ═══════════════════════════════════════════════════════════════
   AUTH
   ═══════════════════════════════════════════════════════════════ */
export const Auth = {

  /** Watch auth state changes */
  onChange: cb => onAuthStateChanged(auth, cb),

  /** Register new invigilator account */
  async register(email, password, displayName) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    // Create user profile in Firestore
    await setDoc(doc(db, 'users', cred.user.uid), {
      uid:         cred.user.uid,
      email:       email.toLowerCase().trim(),
      displayName: displayName.trim(),
      role:        'invigilator',
      createdAt:   serverTimestamp(),
      active:      true,
    });
    return cred.user;
  },

  /** Sign in */
  async login(email, password) {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user;
  },

  /** Sign out */
  logout: () => signOut(auth),

  /** Change password (requires re-auth) */
  async changePassword(currentPassword, newPassword) {
    const user = auth.currentUser;
    const cred = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, cred);
    await updatePassword(user, newPassword);
  },

  /** Password reset email */
  resetPassword: email => sendPasswordResetEmail(auth, email),

  /** Get current user profile from Firestore */
  async getProfile(uid) {
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists() ? snap.data() : null;
  },
};

/* ═══════════════════════════════════════════════════════════════
   TIMETABLE
   ═══════════════════════════════════════════════════════════════ */
export const Timetable = {

  /** Save full exam list to Firestore (admin only, replaces all) */
  async saveExams(exams, periodLabel) {
    const batch = writeBatch(db);
    // Archive current period first
    const archiveRef = doc(collection(db, 'timetable_archive'));
    const current    = await getDocs(collection(db, 'exams'));
    if (!current.empty) {
      const existing = current.docs.map(d => d.data());
      batch.set(archiveRef, {
        label:     periodLabel || `Archive ${new Date().toLocaleDateString('en-GB')}`,
        savedAt:   serverTimestamp(),
        examCount: existing.length,
        exams:     existing,
      });
    }
    // Delete all current exams
    current.docs.forEach(d => batch.delete(d.ref));
    // Add new exams
    exams.forEach(exam => {
      const ref = doc(db, 'exams', exam.id);
      batch.set(ref, { ...exam, updatedAt: serverTimestamp() });
    });
    await batch.commit();
  },

  /** Get all current exams */
  async getAll() {
    const snap = await getDocs(query(collection(db, 'exams'), orderBy('date'), orderBy('startTime')));
    return snap.docs.map(d => d.data());
  },

  /** Real-time listener for exams */
  onExamsChange: cb => onSnapshot(
    query(collection(db, 'exams'), orderBy('date'), orderBy('startTime')),
    snap => cb(snap.docs.map(d => d.data()))
  ),

  /** Get exams for a specific invigilator (by name aliases) */
  async getForInvigilator(aliases) {
    const all = await Timetable.getAll();
    return all.filter(exam =>
      aliases.some(alias =>
        normaliseAlias(exam.invigRaw)  === normaliseAlias(alias) ||
        normaliseAlias(exam.backupRaw) === normaliseAlias(alias)
      )
    );
  },

  /** Real-time exams for an invigilator */
  onExamsForInvigilator(aliases, cb) {
    return onSnapshot(
      query(collection(db, 'exams'), orderBy('date'), orderBy('startTime')),
      snap => {
        const all = snap.docs.map(d => d.data());
        cb(all.filter(exam =>
          aliases.some(alias =>
            normaliseAlias(exam.invigRaw)  === normaliseAlias(alias) ||
            normaliseAlias(exam.backupRaw) === normaliseAlias(alias)
          )
        ));
      }
    );
  },

  /** Get archived timetables */
  async getArchives() {
    const snap = await getDocs(query(collection(db, 'timetable_archive'), orderBy('savedAt', 'desc')));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  /** Update a single exam's notification flags */
  async markNotified(examId, type) {
    const field = type === 'main' ? 'notifiedMain' : 'notifiedBackup';
    await updateDoc(doc(db, 'exams', examId), { [field]: true });
  },
};

/* ═══════════════════════════════════════════════════════════════
   INVIGILATORS
   ═══════════════════════════════════════════════════════════════ */
export const Invigilators = {

  /** Get all invigilator user profiles */
  async getAll() {
    const snap = await getDocs(query(collection(db, 'users'), where('role', '==', 'invigilator')));
    return snap.docs.map(d => d.data());
  },

  /** Update profile */
  async update(uid, data) {
    await updateDoc(doc(db, 'users', uid), { ...data, updatedAt: serverTimestamp() });
  },

  /** Deactivate */
  async setActive(uid, active) {
    await updateDoc(doc(db, 'users', uid), { active, updatedAt: serverTimestamp() });
  },

  /** Real-time listener */
  onInvigilatorsChange: cb => onSnapshot(
    query(collection(db, 'users'), where('role', '==', 'invigilator')),
    snap => cb(snap.docs.map(d => d.data()))
  ),
};

/* ═══════════════════════════════════════════════════════════════
   NOTIFICATIONS LOG
   ═══════════════════════════════════════════════════════════════ */
export const NotifLog = {

  async add(entry) {
    await addDoc(collection(db, 'notif_log'), {
      ...entry,
      ts: serverTimestamp(),
    });
  },

  async getRecent(limit = 200) {
    const snap = await getDocs(
      query(collection(db, 'notif_log'), orderBy('ts', 'desc'))
    );
    return snap.docs.slice(0, limit).map(d => ({ id: d.id, ...d.data() }));
  },

  onRecentChange: cb => onSnapshot(
    query(collection(db, 'notif_log'), orderBy('ts', 'desc')),
    snap => cb(snap.docs.slice(0, 200).map(d => ({ id: d.id, ...d.data() })))
  ),
};

/* ═══════════════════════════════════════════════════════════════
   ADMIN SETTINGS (stored in Firestore so GitHub Actions can read)
   ═══════════════════════════════════════════════════════════════ */
export const Settings = {
  async get() {
    const snap = await getDoc(doc(db, 'config', 'settings'));
    return snap.exists() ? snap.data() : {};
  },
  async save(data) {
    await setDoc(doc(db, 'config', 'settings'), data, { merge: true });
  },
};

/* ── Helpers ──────────────────────────────────────────────────── */
function normaliseAlias(s) {
  return (s || '').toString().replace(/\/+$/, '').trim().toLowerCase();
}
