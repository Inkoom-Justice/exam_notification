/* ═══════════════════════════════════════════════════════════════
   FIREBASE SERVICE — src/firebase-service.js
   Uses the Firebase Compat SDK (loaded via CDN <script> tags).
   Exposes all operations via window.FirebaseService so that
   the plain (non-module) app.js can call them.
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // Guard: if Firebase SDK not loaded yet, bail silently
  if (typeof firebase === 'undefined') {
    console.warn('[FirebaseService] Firebase SDK not loaded.');
    return;
  }

  // Guard: if config not filled in, bail with a helpful message
  if (!window.FIREBASE_CONFIG || window.FIREBASE_CONFIG.apiKey === 'YOUR_API_KEY') {
    console.warn('[FirebaseService] Firebase config not set. Fill in src/firebase-config.js.');
    return;
  }

  // Initialise (safe to call multiple times)
  if (!firebase.apps.length) {
    firebase.initializeApp(window.FIREBASE_CONFIG);
  }

  const db   = firebase.firestore();
  const auth = firebase.auth();

  /* ── Auth ──────────────────────────────────────────────────── */
  function ensureAuth() {
    return new Promise((resolve, reject) => {
      const unsub = auth.onAuthStateChanged(user => {
        unsub();
        if (user) { resolve(user); return; }
        auth.signInAnonymously()
          .then(cred => resolve(cred.user))
          .catch(reject);
      });
    });
  }

  /* ── Settings ──────────────────────────────────────────────── */
  const Settings = {
    async get() {
      const snap = await db.collection('config').doc('settings').get();
      return snap.exists ? snap.data() : {};
    },
    async save(data) {
      await db.collection('config').doc('settings').set(data, { merge: true });
    },
  };

  /* ── Invigilators ──────────────────────────────────────────── */
  const Invigilators = {
    async getAll() {
      const snap = await db.collection('invigilators').get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async save(inv) {
      await db.collection('invigilators').doc(inv.id).set(inv, { merge: true });
    },
    async saveAll(list) {
      const batch = db.batch();
      list.forEach(inv => batch.set(db.collection('invigilators').doc(inv.id), inv));
      await batch.commit();
    },
    async delete(id) {
      await db.collection('invigilators').doc(id).delete();
    },
  };

  /* ── Timetable ─────────────────────────────────────────────── */
  const Timetable = {
    async saveActive(exams, label) {
      await db.collection('timetable').doc('active').set({
        label:     label || `Synced ${new Date().toLocaleDateString('en-GB')}`,
        syncedAt:  firebase.firestore.FieldValue.serverTimestamp(),
        examCount: exams.length,
        exams,
      });
    },
    async getActive() {
      const snap = await db.collection('timetable').doc('active').get();
      return snap.exists ? snap.data() : null;
    },
    async archiveCurrent(label) {
      const active = await Timetable.getActive();
      if (!active || !active.exams || !active.exams.length) {
        throw new Error('No active timetable to archive');
      }
      const archiveId = 'archive_' + Date.now();
      await db.collection('timetable_archive').doc(archiveId).set({
        ...active,
        archiveLabel: label || active.label,
        archivedAt:   firebase.firestore.FieldValue.serverTimestamp(),
      });
      return archiveId;
    },
    async getArchives() {
      const snap = await db.collection('timetable_archive')
        .orderBy('archivedAt', 'desc').get();
      return snap.docs.map(d => ({
        id:         d.id,
        label:      d.data().archiveLabel || d.data().label,
        examCount:  d.data().examCount,
        archivedAt: d.data().archivedAt?.toDate?.() || new Date(),
        exams:      d.data().exams || [],
      }));
    },
    async deleteArchive(id) {
      await db.collection('timetable_archive').doc(id).delete();
    },
    async markNotified(examId, type) {
      const field = type === 'main' ? 'notifiedMain' : 'notifiedBackup';
      await db.collection('notif_flags').doc(examId)
        .set({ [field]: true }, { merge: true });
    },
    async getAllFlags() {
      const snap = await db.collection('notif_flags').get();
      const flags = {};
      snap.docs.forEach(d => { flags[d.id] = d.data(); });
      return flags;
    },
  };

  /* ── Notification Log ──────────────────────────────────────── */
  const NotifLog = {
    async add(entry) {
      await db.collection('notif_log').add({
        ...entry,
        ts: firebase.firestore.FieldValue.serverTimestamp(),
      });
    },
    async getRecent(limit = 300) {
      const snap = await db.collection('notif_log')
        .orderBy('ts', 'desc').limit(limit).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
  };

  /* ── Expose on window so plain scripts can access ──────────── */
  window.FirebaseService = { ensureAuth, Settings, Invigilators, Timetable, NotifLog };
  console.log('[FirebaseService] Ready.');

})();
