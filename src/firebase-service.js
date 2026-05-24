/* ═══════════════════════════════════════════════════════════════
   FIREBASE SERVICE — src/firebase-service.js
   All Firestore read/write operations for the notifier system.
   Imported as ES module from index.html via type="module".
   ═══════════════════════════════════════════════════════════════ */

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, doc, getDocs, getDoc,
         setDoc, addDoc, updateDoc, deleteDoc,
         query, orderBy, onSnapshot, serverTimestamp, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const app  = initializeApp(FIREBASE_CONFIG);
export const db   = getFirestore(app);
export const auth = getAuth(app);

/* ── Anonymous auth (just to satisfy Firestore rules) ─────────── */
export function ensureAuth() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, user => {
      if (user) resolve(user);
      else signInAnonymously(auth).then(c => resolve(c.user)).catch(reject);
    });
  });
}

/* ════════════════════════════════════════════════════════════════
   SETTINGS  (doc: config/settings)
   ════════════════════════════════════════════════════════════════ */
export const Settings = {
  async get() {
    const snap = await getDoc(doc(db, 'config', 'settings'));
    return snap.exists() ? snap.data() : {};
  },
  async save(data) {
    await setDoc(doc(db, 'config', 'settings'), data, { merge: true });
  },
};

/* ════════════════════════════════════════════════════════════════
   INVIGILATORS  (collection: invigilators)
   ════════════════════════════════════════════════════════════════ */
export const Invigilators = {
  async getAll() {
    const snap = await getDocs(collection(db, 'invigilators'));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async save(inv) {
    // inv.id is the document id
    await setDoc(doc(db, 'invigilators', inv.id), inv, { merge: true });
  },
  async delete(id) {
    await deleteDoc(doc(db, 'invigilators', id));
  },
  async saveAll(list) {
    const batch = writeBatch(db);
    list.forEach(inv => batch.set(doc(db, 'invigilators', inv.id), inv));
    await batch.commit();
  },
  onChange(cb) {
    return onSnapshot(collection(db, 'invigilators'), snap =>
      cb(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
  },
};

/* ════════════════════════════════════════════════════════════════
   ACTIVE TIMETABLE  (doc: timetable/active — stores exam array)
   ════════════════════════════════════════════════════════════════ */
export const Timetable = {

  /** Save exams as active timetable. Overwrites the single active doc. */
  async saveActive(exams, label) {
    await setDoc(doc(db, 'timetable', 'active'), {
      label:     label || `Synced ${new Date().toLocaleDateString('en-GB')}`,
      syncedAt:  serverTimestamp(),
      examCount: exams.length,
      exams,
    });
  },

  /** Get active timetable */
  async getActive() {
    const snap = await getDoc(doc(db, 'timetable', 'active'));
    return snap.exists() ? snap.data() : null;
  },

  /** Real-time listener for active timetable */
  onActiveChange(cb) {
    return onSnapshot(doc(db, 'timetable', 'active'), snap =>
      cb(snap.exists() ? snap.data() : null)
    );
  },

  /** Archive the current active timetable (user-triggered Save) */
  async archiveCurrent(label) {
    const active = await Timetable.getActive();
    if (!active || !active.exams || !active.exams.length) {
      throw new Error('No active timetable to archive');
    }
    const archiveId = `archive_${Date.now()}`;
    await setDoc(doc(db, 'timetable_archive', archiveId), {
      ...active,
      archiveLabel: label || active.label,
      archivedAt:   serverTimestamp(),
    });
    return archiveId;
  },

  /** Get all archived timetables (metadata only) */
  async getArchives() {
    const snap = await getDocs(
      query(collection(db, 'timetable_archive'), orderBy('archivedAt', 'desc'))
    );
    return snap.docs.map(d => ({
      id: d.id,
      label:      d.data().archiveLabel || d.data().label,
      examCount:  d.data().examCount,
      archivedAt: d.data().archivedAt?.toDate?.() || new Date(),
      exams:      d.data().exams || [],
    }));
  },

  /** Delete an archived timetable */
  async deleteArchive(id) {
    await deleteDoc(doc(db, 'timetable_archive', id));
  },

  /** Mark a single exam's notification status */
  async markNotified(examId, type) {
    // We store notif flags separately to avoid rewriting the whole 5MB exams array
    const field = type === 'main' ? 'notifiedMain' : 'notifiedBackup';
    await setDoc(doc(db, 'notif_flags', examId), { [field]: true }, { merge: true });
  },

  /** Get all notification flags */
  async getAllFlags() {
    const snap = await getDocs(collection(db, 'notif_flags'));
    const flags = {};
    snap.docs.forEach(d => { flags[d.id] = d.data(); });
    return flags;
  },
};

/* ════════════════════════════════════════════════════════════════
   NOTIFICATION LOG  (collection: notif_log)
   ════════════════════════════════════════════════════════════════ */
export const NotifLog = {
  async add(entry) {
    await addDoc(collection(db, 'notif_log'), {
      ...entry,
      ts: serverTimestamp(),
    });
  },
  async getRecent(limit = 300) {
    const snap = await getDocs(
      query(collection(db, 'notif_log'), orderBy('ts', 'desc'))
    );
    return snap.docs.slice(0, limit).map(d => ({ id: d.id, ...d.data() }));
  },
  onChange(cb) {
    return onSnapshot(
      query(collection(db, 'notif_log'), orderBy('ts', 'desc')),
      snap => cb(snap.docs.slice(0, 300).map(d => ({ id: d.id, ...d.data() })))
    );
  },
};
