/* ═══════════════════════════════════════════════════════════════
   REGENT EXAM NOTIFIER — app.js
   Warsaw timezone · finish/ext-time status · auto notifications
   ═══════════════════════════════════════════════════════════════ */
'use strict';

/* ─── STORAGE ──────────────────────────────────────────────────── */
// S = localStorage only (keep for legacy reads during migration)
const S = {
  get(k)    { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) { console.error(e); } },
};

// DB = localStorage + Firebase cloud mirror
// Writes go to both; reads come from localStorage (seeded from Firebase on startup).
const DB = {
  get(k)    { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) { console.error(e); }
    // Background cloud write — non-blocking
    if (window.FB?.SimpleDB) {
      window.FB.SimpleDB.set(k, v).catch(e => console.warn('[DB] cloud write failed:', e.message));
    }
  },
};

/* ─── DEFAULTS ─────────────────────────────────────────────────── */
const DEFAULT_SETTINGS = {
  sheetsUrl:'', sheetsGid:'1559134635',
  ejsPublicKey:'', ejsServiceId:'', ejsTemplateId:'', ejsScheduleTemplateId:'',
  workerUrl:'',   // Cloudflare Worker URL for PDF email via Resend
  notifyMinutes:60, emailDomain:'regent.edu.pl',
  timezone:'Europe/Warsaw', pin:'1234'
};

const DEFAULT_INVIGILATORS = [
  { id:'inv_1',  name:'Anna Martowicz',      email:'', aliases:['AM','Anna M','Anna Martowicz'],                        active:true },
  { id:'inv_2',  name:'Mariusz Krajewski',   email:'', aliases:['Mariusz','Krajewski','Mariusz Krajewski'],             active:true },
  { id:'inv_3',  name:'Anna Santos',         email:'', aliases:['Anna Santos','Santos'],                                active:true },
  { id:'inv_4',  name:'Marta Szweda',        email:'', aliases:['Marta','Marta Szweda','Szweda'],                       active:true },
  { id:'inv_5',  name:'Krzysztof Martowicz', email:'', aliases:['KM','Krzysztof','Krzysztof Martowicz','Martowicz'],    active:true },
  { id:'inv_6',  name:'Maciej Pyrka',        email:'', aliases:['Maciek','Maciek/','Maciek//','Maciej','Maciej Pyrka'], active:true },
  { id:'inv_7',  name:'Anna Panfil',         email:'', aliases:['Panfil','Anna Panfil'],                                active:true },
  { id:'inv_8',  name:'Roger Messer',        email:'', aliases:['Roger','Roger Messer','Messer'],                       active:true },
  { id:'inv_9',  name:'Kristy Khemraj',      email:'', aliases:['Kristy','Kristy Khemraj','Kristy//','Khemraj'],       active:true },
  { id:'inv_10', name:'Justice Inkoom',      email:'', aliases:['Justice','Justice//','Justice Inkoom'],                active:true },
  { id:'inv_11', name:'Zipporah Bvalani',    email:'', aliases:['Zipporah','Zipporah//','Zipporah Bvalani'],            active:true },
  { id:'inv_12', name:'Szymon',              email:'', aliases:['Szymon','Szymon//'],                                   active:true },
];

/* ─── STATE ────────────────────────────────────────────────────── */
let exams        = DB.get('exams')        || [];
let invigilators = DB.get('invigilators') || DEFAULT_INVIGILATORS;
let notifLog     = DB.get('notifLog')     || [];
let editingId    = null;

function getSettings() {
  return Object.assign({}, DEFAULT_SETTINGS, DB.get('settings') || {});
}
function saveSettings(patch) {
  DB.set('settings', Object.assign(getSettings(), patch));
}

/* ═══════════════════════════════════════════════════════════════
   WARSAW TIME HELPERS
   All exam times are treated as Europe/Warsaw local time.
   We never use toISOString() for date comparisons.
   ═══════════════════════════════════════════════════════════════ */

/** Current date string in Warsaw: "YYYY-MM-DD" */
function warsawTodayISO() {
  return new Date().toLocaleDateString('sv-SE', { timeZone:'Europe/Warsaw' });
}

/** Current time in Warsaw as total minutes since midnight */
function warsawNowMinutes() {
  const t = new Date().toLocaleTimeString('en-GB', { timeZone:'Europe/Warsaw', hour:'2-digit', minute:'2-digit' });
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** Parse "HH:MM", "circa 4:15 pm", "~16:30", "approx 9:00am" → total minutes.
 *  Returns null if unparseable. */
function parseTimeToMins(raw) {
  if (!raw) return null;
  let s = raw.toString().trim();

  // Excel fractional day (e.g. 0.6875 = 16:30)
  if (/^\d+\.\d+$/.test(s)) return Math.round(parseFloat(s) * 24 * 60);

  // Strip approximate-time noise words and leading ~ symbols
  s = s.replace(/^~+\s*/, '');
  s = s.replace(/^\s*(circa|approx(?:imately)?|around|about|est\.?|c\.)\s*/i, '').trim();

  // Capture optional am/pm then remove it so the number-match is clean
  const ampmMatch = s.match(/\b(a\.?m\.?|p\.?m\.?)\b/i);
  const ampm = ampmMatch ? ampmMatch[1].replace(/\./g, '').toLowerCase() : null;
  s = s.replace(/\b(a\.?m\.?|p\.?m\.?)\b/i, '').trim();

  // Match H, H:MM, or H:MM:SS
  const match = s.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?/);
  if (!match) return null;

  let h = parseInt(match[1]);
  const m = match[2] ? parseInt(match[2]) : 0;

  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;

  return h * 60 + m;
}

/** Minutes → "HH:MM" */
function minsToTime(mins) {
  if (mins == null || isNaN(mins)) return '';
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

/** Add delta minutes to "HH:MM" → "HH:MM" */
function addMins(timeStr, delta) {
  const base = parseTimeToMins(timeStr);
  if (base == null) return '';
  return minsToTime(base + delta);
}

/* ═══════════════════════════════════════════════════════════════
   STATUS ENGINE  (Warsaw-aware)
   ═══════════════════════════════════════════════════════════════ */
function examStatus(exam) {
  const todayStr  = warsawTodayISO();
  const nowMins   = warsawNowMinutes();
  const { notifyMinutes } = getSettings();

  const startMins  = parseTimeToMins(exam.startTime);
  const finishMins = parseTimeToMins(exam.finishTime);
  const extMins    = parseTimeToMins(exam.extFinishTime);

  const isToday = exam.date === todayStr;
  const isPast  = exam.date < todayStr;
  const isFuture= exam.date > todayStr;

  if (isPast) return { cls:'status-past', label:'⚫ Past' };
  if (isFuture) return { cls:'status-future', label:`${fmtDate(exam.date)}` };

  if (extMins != null && nowMins >= startMins && nowMins < extMins) {
    return { cls:'status-extended', label:`🔵 Extended · ends ${minsToTime(extMins)}` };
  }
  if (finishMins != null && nowMins >= startMins && nowMins < finishMins) {
    return { cls:'status-ongoing', label:`🟢 Ongoing · ends ${minsToTime(finishMins)}` };
  }
  const endMins = extMins || finishMins;
  if (endMins != null && nowMins >= endMins) return { cls:'status-past', label:'⚫ Past' };
  if (finishMins == null && nowMins > startMins + 30) return { cls:'status-past', label:'⚫ Past' };

  // Read local/live variables loaded from your storage sync engine
  if (exam.notifiedMain === 'auto' && exam.notifiedBackup === 'auto') return { cls:'status-notified', label:'✓ Notified auto' };
  if (exam.notifiedMain === 'auto') return { cls:'status-notified', label:'✓ Main auto' };

  if (exam.notifiedMain && exam.notifiedBackup) return { cls:'status-notified', label:'✓ Notified' };
  if (exam.notifiedMain)                         return { cls:'status-notified', label:'✓ Main sent' };

  
  const minsUntil = startMins - nowMins;
  if (minsUntil >= 0 && minsUntil <= notifyMinutes) {
    return { cls:'status-window', label:`⏰ Notify in ${minsUntil}m` };
  }

  const h = Math.floor(minsUntil / 60);
  const m = minsUntil % 60;
  return { cls:'status-future', label: h > 0 ? `In ${h}h ${m}m` : `In ${m}m` };
}

/* ═══════════════════════════════════════════════════════════════
   AUTH
   ═══════════════════════════════════════════════════════════════ */
function login() {
  try {
    const pinInput = document.getElementById('pinInput');
    const errEl    = document.getElementById('loginErr');
    if (!pinInput) { console.error('[login] pinInput element not found'); return; }
    const pin = (pinInput.value || '').trim();
    if (errEl) errEl.textContent = '';
    if (!pin) { if (errEl) errEl.textContent = 'Please enter your PIN.'; return; }
    const stored = String(getSettings().pin);
    if (pin === stored) {
      document.getElementById('loginScreen').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      pinInput.value = '';
      initApp();
    } else {
      if (errEl) errEl.textContent = 'Incorrect PIN — please try again.';
      pinInput.value = ''; pinInput.focus();
    }
  } catch(e) {
    console.error('[login] error:', e);
    alert('Login error: ' + e.message);
  }
}

function logout() {
  document.getElementById('app').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
  const p = document.getElementById('pinInput');
  if (p) { p.value = ''; p.focus(); }
  document.getElementById('loginErr').textContent = '';
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('loginBtn');
  const pin = document.getElementById('pinInput');
  if (btn) btn.addEventListener('click', login);
  if (pin) { pin.addEventListener('keydown', e => { if (e.key==='Enter') login(); }); pin.focus(); }
});

/* ═══════════════════════════════════════════════════════════════
   INIT & TABS
   ═══════════════════════════════════════════════════════════════ */
async function initApp() {
  // ── Seed from Firebase cloud on startup ──────────────────────
  // Wait up to 4s for Firebase to be ready, then proceed regardless.
  if (window.FB?.SimpleDB) {
    try {
      showBanner('☁ Loading from cloud…', 'ok');
      const cloud = await window.FB.SimpleDB.getAll(
        ['exams','invigilators','notifLog','settings','archives']
      );
      let synced = 0;
      if (cloud.exams        && Array.isArray(cloud.exams))        { exams         = cloud.exams;        S.set('exams', exams); synced++; }
      if (cloud.invigilators && Array.isArray(cloud.invigilators)) { invigilators  = cloud.invigilators; S.set('invigilators', invigilators); synced++; }
      if (cloud.notifLog     && Array.isArray(cloud.notifLog))     { notifLog      = cloud.notifLog;     S.set('notifLog', notifLog); synced++; }
      if (cloud.settings     && typeof cloud.settings === 'object'){ S.set('settings', cloud.settings); synced++; }
      if (cloud.archives     && Array.isArray(cloud.archives))     { S.set('archives', cloud.archives); synced++; }
      if (synced > 0) console.info(`[Firebase] Seeded ${synced} data keys from cloud ✓`);
    } catch(e) {
      console.warn('[Firebase] Cloud seed failed, using local data:', e.message);
    }
  }

  loadSettingsUI();
  renderInvigilators();
  renderDashboard();
  renderTimetable();
  renderLog();
  updateStats();
  setInterval(() => { renderDashboard(); renderTimetable(); updateStats(); }, 60000);


  // ── Show cloud status in UI ───────────────────────────────────
  if (window.FB?.SimpleDB) {
    showToast('☁ Cloud sync active ✓', 'success');
  } else {
    console.info('[Storage] Running in local-only mode (Firebase not loaded).');
  }
}

function switchTab(name, el) {
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const sec = document.getElementById('tab-' + name);
  if (sec) sec.classList.add('active');
  if (el)  el.classList.add('active');
  if (name === 'archive') loadArchiveList();
  if (name === 'log') renderLog();
}

/* ═══════════════════════════════════════════════════════════════
   EMAIL HELPERS
   ═══════════════════════════════════════════════════════════════ */
function generateEmail(name) {
  const domain = getSettings().emailDomain || 'regent.edu.pl';
  const clean  = name.replace(/\s*\(.*?\)\s*/g,'').trim();
  const parts  = clean.toLowerCase().replace(/[^a-z\s]/g,'').trim().split(/\s+/);
  return parts.length >= 2 ? `${parts[0]}.${parts[parts.length-1]}@${domain}` : `${parts[0]}@${domain}`;
}

function resolveEmail(inv) {
  if (inv && inv.email && inv.email.trim()) return inv.email.trim();
  return generateEmail((inv && inv.name) ? inv.name : 'unknown');
}

/** Split semicolon/comma/newline separated names into individual names */
function resolveAll(raw) {
  if (!raw) return [];

  let s = raw.toString();

  // Strip parenthetical notes: "(technical)", "(supervision)"
  s = s.replace(/\(.*?\)/g, '');

  // Strip role label prefixes: "Examiner:", "PRS -", "WRS -"
  s = s.replace(/\b(Examiner|PRS|WRS|Supervisor)\s*[-:]?\s*/gi, '');

  // Strip standalone noise words that are not names
  s = s.replace(/\b(technical|supervision|technician)\b/gi, '');

  // Strip double-slashes used as trailing markers: Maciek//, Kristy//
  s = s.replace(/\/\/+/g, '');

  // Replace " i " (Polish "and", space-padded) with comma
  s = s.replace(/ i /gi, ',');

  // Replace remaining separators: +  ;  /  newline → comma
  s = s.replace(/[+;\/\n]+/g, ',');

  // Collapse multiple commas and trim
  s = s.replace(/,+/g, ',').trim();

  const tokens = s.split(',').map(t => t.trim()).filter(Boolean);

  return tokens
    .map(t => resolveInvigilator(t))
    .filter(Boolean)
    .filter((p, i, arr) =>
      arr.findIndex(q => resolveEmail(q) === resolveEmail(p)) === i
    );
}

// splitNames kept for any legacy callers
function splitNames(raw) {
  if (!raw) return [];
  return raw.toString()
    .replace(/\/\/+/g, '')
    .split(/[;,+\/\n]+/)
    .map(s => s.trim())
    .filter(s => s && s !== '-' && s.toLowerCase() !== 'nan');
}

function resolveInvigilator(rawName) {
  if (!rawName) return null;
  const cleaned = rawName.toString().replace(/\/+$/, '').trim();
  if (!cleaned || cleaned === '-' || cleaned.toLowerCase() === 'nan') return null;
  const token = cleaned.toLowerCase();

  // 1. Exact alias match (slashes stripped)
  const byAlias = invigilators.find(inv =>
    inv.active && inv.aliases.some(a =>
      a.replace(/\/+$/, '').trim().toLowerCase() === token
    )
  );
  if (byAlias) return byAlias;

  // 2. Any single word in full name — "Panfil"→Anna Panfil, "Marta"→Marta Szweda
  const byNameWord = invigilators.find(inv =>
    inv.active && inv.name.toLowerCase().split(/\s+/).some(w => w === token)
  );
  if (byNameWord) return byNameWord;

  // 3. Any single word in any alias
  const byAliasWord = invigilators.find(inv =>
    inv.active && inv.aliases.some(a =>
      a.replace(/\/+$/, '').toLowerCase().split(/\s+/).some(w => w === token)
    )
  );
  if (byAliasWord) return byAliasWord;

  // 4. Substring of full name or alias
  const bySubstring = invigilators.find(inv =>
    inv.active && (
      inv.name.toLowerCase().includes(token) ||
      inv.aliases.some(a => a.toLowerCase().includes(token))
    )
  );
  if (bySubstring) return bySubstring;

  return null; // unknown — drop silently rather than generate a bad email
}

// resolveOne is the same as resolveInvigilator — alias for readability
function resolveOne(t) { return resolveInvigilator(t); }


const PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  url => `https://thingproxy.freeboard.io/fetch/${url}`,
];
const PROXY_NAMES = ['corsproxy.io','codetabs.com','allorigins.win','thingproxy'];

async function proxyFetch(csvUrl, onProgress) {
  let lastErr = 'Unknown';

  // Try direct fetch first — works on GitHub Pages and local dev server (not file://)
  try {
    if (onProgress) onProgress('Trying direct fetch…');
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(csvUrl, { signal: ctrl.signal });
    if (res.ok) {
      const text = await res.text();
      if (text.includes(',') && text.split('\n').length > 2 && !text.trimStart().startsWith('<')) {
        return { csv: text, proxy: 'direct' };
      }
    }
  } catch(e) { /* CORS block from file:// — fall through to proxies */ }

  for (let i = 0; i < PROXIES.length; i++) {
    if (onProgress) onProgress(`Trying proxy ${i+1}/4: ${PROXY_NAMES[i]}…`);
    try {
      const ctrl = new AbortController();
      const t    = setTimeout(() => ctrl.abort(), 12000);
      const res  = await fetch(PROXIES[i](csvUrl), { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // allorigins returns JSON wrapper — unwrap it
      try {
        const j = JSON.parse(text);
        if (j && j.contents) {
          if (j.contents.trimStart().startsWith('<')) throw new Error('Proxy got HTML — sheet needs login');
          if (j.contents.includes(',') && j.contents.split('\n').length > 2)
            return { csv: j.contents, proxy: PROXY_NAMES[i] };
        }
      } catch(je) { if (je.message.includes('login')) throw je; }
      // Raw CSV
      if (text.trimStart().startsWith('<')) throw new Error('Got HTML instead of CSV — sheet needs login');
      if (text.includes(',') && text.split('\n').length > 2) return { csv: text, proxy: PROXY_NAMES[i] };
      throw new Error(`Not CSV (${text.length} bytes, starts: ${text.substring(0,40)})`);
    } catch(e) {
      lastErr = e.name === 'AbortError' ? 'Timed out' : e.message;
      console.warn(`[Proxy ${i+1}] ${PROXY_NAMES[i]}: ${lastErr}`);
    }
  }

  if (window.location.protocol === 'file:') {
    throw new Error(
      'Running from file:// — browser blocks all network requests.\n' +
      'Fix: open a terminal in your project folder and run:\n' +
      '  python -m http.server 8000\n' +
      'Then open: http://localhost:8000'
    );
  }
  throw new Error(`All 4 proxies failed. Last error: ${lastErr}`);
}

/* ═══════════════════════════════════════════════════════════════
   GOOGLE SHEETS SYNC
   ═══════════════════════════════════════════════════════════════ */
async function fetchTimetable() {
  const url = getSettings().sheetsUrl;
  showBanner('⏳ Connecting to Google Sheets…','info');
  if (!url) { showBanner('❌ No sheet URL. Go to Settings → Google Sheets.','err'); return; }
  try {
    const { csv, proxy } = await proxyFetch(url, msg => showBanner(`⏳ ${msg}`,'info'));
    const count = parseTimetableCSV(csv);
    if (count > 0) showBanner(`✅ Synced via ${proxy} — ${count} exams loaded.`,'ok');
  } catch(e) { showBanner(`❌ ${e.message}`,'err'); }
}

async function testSheetConnection() {
  const url = document.getElementById('sheetsUrl').value.trim();
  const el  = document.getElementById('connResult');
  if (!url) { showResult(el,'⚠️ Paste your CSV URL first.','err'); return; }
  showResult(el,'⏳ Testing…','info');
  try {
    const { csv, proxy } = await proxyFetch(url, msg => showResult(el,`⏳ ${msg}`,'info'));
    const rows = csv.split('\n').filter(r=>r.trim()).length;
    showResult(el,`✅ Connected via ${proxy}! Got ${rows} rows. Click Sync Now.`,'ok');
  } catch(e) {
    showResult(el,`❌ ${e.message}\n\nCheck: sheet is published as CSV, URL is correct, sheet is publicly viewable.`,'err');
  }
}

function csvToRows(csv) {
  // RFC-4180 compliant parser — handles quoted fields containing commas
  const rows = [];
  for (const line of csv.split('\n')) {
    const row = []; let inQ = false, cell = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i+1] === '"') { cell += '"'; i++; } // escaped quote
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        row.push(cell); cell = '';   // NO .trim() — preserves trailing spaces in headers
      } else {
        cell += ch;
      }
    }
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function parseTimetableCSV(csv) {
  const diag = [];
  const rows = csvToRows(csv);
  diag.push(`📄 ${rows.length} lines received from Google Sheets`);

  // ── Find header row ──────────────────────────────────────────
  let hi = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].map(c => (c||'').toLowerCase());
    if (r.some(c => c.includes('start time')) && r.some(c => c.includes('invigilator'))) {
      hi = i; break;
    }
  }
  if (hi === -1) {
    showBanner('❌ Header row not found — could not find columns "Start time" and "Invigilator" together. ' +
      'Check the correct sheet tab is published as CSV.', 'err');
    return 0;
  }
  diag.push(`✅ Header found at row ${hi}`);

  // ── Map columns ──────────────────────────────────────────────
  // The sheet has TWO "Exam Date" columns:
  //   col 5 = "Exam Date"  → range/text label, ignored
  //   col 8 = "Exam Date " → actual datetime value (second occurrence)
  // col() returns the first match; colLast() returns the last match so we
  // always land on the actual datetime column regardless of column order.
  const H_raw = rows[hi];
  const H     = H_raw.map(c => (c||'').toLowerCase().trim()); // trimmed for keyword search
  const col     = kw => H.findIndex(h => h.includes(kw.toLowerCase()));
  const colLast = kw => { let idx = -1; H.forEach((h, i) => { if (h.includes(kw.toLowerCase())) idx = i; }); return idx; };

  const C = {
    date:         colLast('exam date'),   // second "Exam Date" col = actual datetime
	room:         col('room'),
    session:      col('session'),
    start:        col('start time'),
    readiness:    col('full-readiness'),
    duration:     col('duration in min'),
    finish:       col('finish time'),
    extMins:      col('ext. time in min'),
    extFinish:    col('ext. finish time'),
    extFor:       col('extended time for'),
    entries:      col('entries'),          // 🌟 Added configuration map mark
    invig:        col('exam invigilator'),
    backup:       col('backup invigilator'),
    comments:     col('comments'),
    syllabus:     col('syllabus'),
    component:    col('component title'),
    code:         col('code'),
  };

  diag.push(`🗂 Columns: date=${C.date} start=${C.start} entries=${C.entries} syllabus=${C.syllabus} invig=${C.invig} backup=${C.backup}`);
  console.info('[Sync] Column map:', C);
  console.info('[Sync] Header row raw:', H_raw.slice(0, 12));

  if (C.start < 0)    { showBanner('❌ "Start time" column not found. ' + diag.join(' | '), 'err'); return 0; }
  if (C.syllabus < 0) { showBanner('❌ "Syllabus" column not found. '   + diag.join(' | '), 'err'); return 0; }

  // ── Parse rows ───────────────────────────────────────────────
  const existing     = new Map(exams.map(e => [e.id, e]));
  const parsed       = [];
  const seenIds     = new Set();
  let skipBlank = 0, skipDate = 0, skipTime = 0, skipSubject = 0;

  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(c => !c || !c.trim())) { skipBlank++; continue; }

    const rawDate  = (r[C.date]     || '').toString().trim();
    const rawStart = (r[C.start]    || '').toString().trim();
    const syllabus = (r[C.syllabus] || '').toString().trim();

    if (!syllabus) { skipSubject++; continue; }
    if (!rawDate || rawDate === 'NaN') { skipDate++; continue; }

    // Safe date parse — extract YYYY-MM-DD without any new Date() timezone risk
    let dateStr = '';
    if      (/^\d{4}-\d{2}-\d{2}[T \d]/.test(rawDate)) dateStr = rawDate.substring(0, 10);
    else if (/^\d{2}\/\d{2}\/\d{4}$/.test(rawDate)) {
      const [d,m,y] = rawDate.split('/'); dateStr = `${y}-${m}-${d}`;
    }
    else if (/^\d{2}\/\d{2}\/\d{2}$/.test(rawDate)) {
      const [d,m,y] = rawDate.split('/'); dateStr = `20${y}-${m}-${d}`;
    }
    else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(rawDate)) {
      const [d,m,y] = rawDate.split('/'); dateStr = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    }
    else {
      // Any text date — strip optional leading weekday, then parse "DD Month YYYY"
      // Handles: "29 May 2026", "29 Jan 2026", "Friday 29 May 2026", "Fri, 29 May 2026"
      const MONTHS = {
        january:'01', february:'02', march:'03',    april:'04',
        may:'05',     june:'06',     july:'07',     august:'08',
        september:'09',october:'10', november:'11', december:'12',
        jan:'01', feb:'02', mar:'03', apr:'04',
        jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12'
      };
      let s = rawDate.replace(/,/g, '').trim();
      if (/^[A-Za-z]+\s+\d/.test(s)) s = s.replace(/^[A-Za-z]+\s+/, '');
      const p = s.split(/\s+/);
      if (p.length === 3 && /^\d{1,2}$/.test(p[0]) && /^[A-Za-z]+$/.test(p[1]) && /^\d{2,4}$/.test(p[2])) {
        const mon = MONTHS[p[1].toLowerCase()] || MONTHS[p[1].toLowerCase().substring(0,3)];
        if (mon) {
          const yr = p[2].length === 2 ? '20' + p[2] : p[2];
          dateStr  = `${yr}-${mon}-${p[0].padStart(2,'0')}`;
        }
      }
      if (!dateStr && /^\d{5}$/.test(rawDate)) {
        const serial = parseInt(rawDate) - (parseInt(rawDate) > 59 ? 1 : 0);
        const d = new Date(Date.UTC(1899,11,31) + serial * 86400000);
        dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
      }
    }

    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      if (skipDate < 3) diag.push(`⚠ Row ${i}: unparseable date "${rawDate}"`);
      skipDate++; continue;
    }

    if (!rawStart || rawStart === 'NaN') { skipTime++; continue; }
    const startMins = parseTimeToMins(rawStart);
    if (startMins == null) {
      if (skipTime < 3) diag.push(`⚠ Row ${i}: unparseable time "${rawStart}"`);
      skipTime++; continue;
    }

    const finishRaw    = C.finish    >= 0 ? (r[C.finish]    || '').trim() : '';
    const extFinishRaw = C.extFinish >= 0 ? (r[C.extFinish] || '').trim() : '';
    const extMinsRaw   = C.extMins   >= 0 ? (r[C.extMins]   || '').trim() : '';
    const finishMins   = parseTimeToMins(finishRaw);
    let extFinishMins  = parseTimeToMins(extFinishRaw);
    if (extFinishMins == null && finishMins != null && extMinsRaw && extMinsRaw !== '-') {
      const em = parseFloat(extMinsRaw);
      if (!isNaN(em) && em > 0) extFinishMins = finishMins + Math.round(em);
    }

    const code = C.code >= 0 ? (r[C.code] || '').trim() : '';
    // Build base ID from date + time + code/syllabus; if collision exists (same subject at same
    // time in different rooms / different invigilators), append _2, _3 … so every row is kept.
    // ID is date-based only: two rows with different dates are always different records.
    // Rows sharing the same date get _2, _3 … suffixes so every row is preserved.
    let id = `exam_${dateStr}`;
    if (seenIds.has(id)) {
      let n = 2;
      while (seenIds.has(`${id}_${n}`)) n++;
      id = `${id}_${n}`;
    }
    seenIds.add(id);
    const prev = existing.get(id);

    parsed.push({
      id, date: dateStr,
      startTime:    minsToTime(startMins),
      finishTime:   finishMins    != null ? minsToTime(finishMins)    : '',
      extFinishTime:extFinishMins != null ? minsToTime(extFinishMins) : '',
      room:      C.room     >= 0 ? (r[C.room]     || '').trim() : '',
      session:   C.session  >= 0 ? (r[C.session]  || '').trim() : '',
      syllabus,
      component: C.component>= 0 ? (r[C.component]|| '').trim() : '',
      code,
      entries:   C.entries  >= 0 ? (r[C.entries]  || '').trim() : '',
      extFor:    C.extFor   >= 0 ? (r[C.extFor]   || '').trim() : '',
      invigRaw:  C.invig    >= 0 ? (r[C.invig]    || '').trim() : '',
      backupRaw: C.backup   >= 0 ? (r[C.backup]   || '').trim() : '',
      comments:  C.comments >= 0 ? (r[C.comments] || '').trim() : '',
      notifiedMain:   prev ? prev.notifiedMain   : false,
      notifiedBackup: prev ? prev.notifiedBackup : false,
    });
  }

  // ── Summary ──────────────────────────────────────────────────
  diag.push(`📊 Parsed: ${parsed.length} exams | Skipped: ${skipBlank} blank, ${skipSubject} no-subject, ${skipDate} bad-date, ${skipTime} bad-time`);
  console.info('[Sync]', diag.join(' | '));

  if (parsed.length === 0) {
    showBanner(
      '❌ 0 exams loaded.\n' + diag.join('\n') +
      '\n\nOpen browser Console (F12) for full detail.',
      'err'
    );
    return 0;
  }

  exams = parsed;
  DB.set('exams', exams);
  renderDashboard(); renderTimetable(); updateStats();

  const today = warsawTodayISO ? warsawTodayISO() : new Date().toLocaleDateString('sv-SE');
  const todayCount = exams.filter(e => e.date === today).length;
  showBanner(
    `✅ ${parsed.length} exams loaded · ${todayCount} today · ` +
    `skipped: ${skipBlank} blank · ${skipSubject} no-subject · ${skipDate} bad-date · ${skipTime} bad-time`,
    'ok'
  );
  showToast(`${exams.length} exams loaded ✓`, 'success');
  return exams.length;
}


/* ═══════════════════════════════════════════════════════════════
   DASHBOARD
   ═══════════════════════════════════════════════════════════════ */
function renderDashboard() {
  const today   = warsawTodayISO();
  const limit   = new Date();
  limit.setDate(limit.getDate() + 2);
  const limitStr= limit.toLocaleDateString('sv-SE',{timeZone:'Europe/Warsaw'});

  renderExamCards('todayExams',    exams.filter(e=>e.date===today),                     true);
  renderExamCards('upcomingExams', exams.filter(e=>e.date>today && e.date<=limitStr),   true);
}

function renderExamCards(id, list, showBtn) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!list.length) { el.innerHTML='<p class="empty-state">Nothing here.</p>'; return; }
  el.innerHTML = list.map(exam => {
    const st      = examStatus(exam);
    const invigs  = resolveAll(exam.invigRaw);
    const backups = resolveAll(exam.backupRaw);
    const times   = buildTimeline(exam);
    return `
    <div class="exam-card">
      <div class="exam-time-badge">${exam.startTime}<span class="session-tag">${exam.session||'—'}</span></div>
      <div class="exam-info">
        <div class="exam-subject">${esc(exam.syllabus)}</div>
        <div class="exam-component">${esc(exam.component)}</div>
        <div class="exam-meta">
          ${exam.room       ? `<span class="tag tag-room">📍 ${esc(exam.room)}</span>` : ''}
          ${invigs.map(p  => `<span class="tag tag-invig">👤 ${esc(p.name)}</span>`).join('')}
          ${backups.map(p => `<span class="tag tag-backup">🔁 ${esc(p.name)}</span>`).join('')}
          ${times           ? `<span class="tag tag-time">${times}</span>`             : ''}
        </div>
      </div>
      <div class="exam-actions">
        <span class="exam-status ${st.cls}">${st.label}</span>
        ${showBtn ? `<button class="btn-icon" title="Send notification now" onclick="manualNotify('${exam.id}')">📧</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function buildTimeline(exam) {
  const parts = [];
  if (exam.finishTime)    parts.push(`ends ${exam.finishTime}`);
  if (exam.extFinishTime) parts.push(`ext. ${exam.extFinishTime}`);
  if (exam.extFor)        parts.push(`(${esc(exam.extFor)})`);
  return parts.join(' · ');
}

/* ═══════════════════════════════════════════════════════════════
   TIMETABLE
   ═══════════════════════════════════════════════════════════════ */
function renderTimetable() {
  const el = document.getElementById('timetableContainer');
  if (!el) return;
  const q = (document.getElementById('searchExams')?.value||'').toLowerCase();
  const list = q
    ? exams.filter(e=>[e.syllabus,e.component,e.date,e.room,e.invigRaw,e.backupRaw].some(v=>(v||'').toLowerCase().includes(q)))
    : exams;
  if (!list.length) { el.innerHTML='<p class="empty-state">No exams found.</p>'; return; }

  el.innerHTML = `
  <div style="overflow-x:auto">
  <table class="data-table">
    <thead><tr>
      <th>Date</th><th>Start</th><th>Finish</th><th>Ext. End</th>
      <th>Session</th><th>Subject</th><th>Component</th>
      <th>Entries</th> <th>Room</th>
      <th>Main Invigilator</th><th>Backup</th><th>Status</th><th></th>
    </tr></thead>
    <tbody>${list.map(e => {
      const st      = examStatus(e);
      const invigs  = resolveAll(e.invigRaw);
      const backups = resolveAll(e.backupRaw);
      return `<tr>
        <td><strong>${fmtDate(e.date)}</strong></td>
        <td>${e.startTime}</td>
        <td>${e.finishTime    || '—'}</td>
        <td>${e.extFinishTime ? `<span class="tag tag-ext">${e.extFinishTime}</span>` : '—'}</td>
        <td>${esc(e.session||'—')}</td>
        <td>${esc(e.syllabus)}</td>
        <td style="color:var(--text-2);font-size:12px">${esc(e.component)}</td>
        <td><strong>${esc(e.entries || '—')}</strong></td>
        <td><span class="tag tag-room">${esc(e.room||'—')}</span></td>
        <td>${invigs.length  ? invigs.map(p  => `<span class="tag tag-invig">${esc(p.name)}</span>`).join(' ')  : '<span style="color:var(--text-3)">—</span>'}</td>
        <td>${backups.length ? backups.map(p => `<span class="tag tag-backup">${esc(p.name)}</span>`).join(' ') : '<span style="color:var(--text-3)">—</span>'}</td>
        <td><span class="exam-status ${st.cls}">${st.label}</span></td>
        <td><button class="btn-icon" title="Send now" onclick="manualNotify('${e.id}')">📧</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

/* ═══════════════════════════════════════════════════════════════
   INVIGILATORS
   ═══════════════════════════════════════════════════════════════ */
function renderInvigilators() {
  const tbody = document.getElementById('invigilatorBody');
  if (!tbody) return;
  tbody.innerHTML = invigilators.map(inv => `
    <tr>
      <td><strong>${esc(inv.name)}</strong></td>
      <td style="font-size:12px;color:var(--text-2)">${esc(resolveEmail(inv))}</td>
      <td style="font-size:12px;color:var(--text-3)">${esc(inv.aliases.join(', '))}</td>
      <td><span class="${inv.active?'badge-active':'badge-inactive'}">${inv.active?'● Active':'○ Inactive'}</span></td>
      <td>
        <button class="btn-icon" title="View full schedule" onclick="compileInvigilator('${inv.id}')">📋</button>
        <button class="btn-icon" onclick="openEditModal('${inv.id}')">✏️</button>
        <button class="btn-danger" onclick="deleteInvigilator('${inv.id}')">🗑</button>
      </td>
    </tr>`).join('');
}

function openAddModal() {
  editingId = null;
  ['mName','mEmail','mAliases'].forEach(id => { document.getElementById(id).value=''; });
  document.getElementById('mActive').value = 'true';
  document.getElementById('modalTitle').textContent = 'Add Invigilator';
  document.getElementById('invigModal').classList.remove('hidden');
  document.getElementById('mName').focus();
}

function openEditModal(id) {
  const inv = invigilators.find(i=>i.id===id); if (!inv) return;
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Edit Invigilator';
  document.getElementById('mName').value    = inv.name;
  document.getElementById('mEmail').value   = inv.email||'';
  document.getElementById('mAliases').value = inv.aliases.join(', ');
  document.getElementById('mActive').value  = inv.active?'true':'false';
  document.getElementById('invigModal').classList.remove('hidden');
}

function closeModal() { document.getElementById('invigModal').classList.add('hidden'); editingId=null; }

function saveInvigilator() {
  const name = document.getElementById('mName').value.trim();
  if (!name) { showToast('Name is required','error'); return; }
  const email   = document.getElementById('mEmail').value.trim();
  const aliases = document.getElementById('mAliases').value.split(',').map(a=>a.trim()).filter(Boolean);
  const active  = document.getElementById('mActive').value==='true';
  if (editingId) {
    const idx = invigilators.findIndex(i=>i.id===editingId);
    if (idx!==-1) invigilators[idx] = {...invigilators[idx], name, email, aliases, active};
  } else {
    invigilators.push({ id:'inv_'+Date.now(), name, email, aliases, active });
  }
  DB.set('invigilators', invigilators);
  renderInvigilators(); updateStats(); closeModal();
  showToast(editingId?'Invigilator updated ✓':'Invigilator added ✓','success');
}

function deleteInvigilator(id) {
  if (!confirm('Delete this invigilator?')) return;
  invigilators = invigilators.filter(i=>i.id!==id);
  DB.set('invigilators', invigilators);
  renderInvigilators(); updateStats(); showToast('Deleted');
}

/* ═══════════════════════════════════════════════════════════════
   EMAILJS
   ═══════════════════════════════════════════════════════════════ */
function initEmailJS() {
  const { ejsPublicKey } = getSettings();
  if (!ejsPublicKey) return false;
  try { emailjs.init(ejsPublicKey); return true; } catch(e) { return false; }
}

async function sendOneEmail(exam, person, role) {
  const s      = getSettings();
  const email  = resolveEmail(person);
  const params = {
    to_name:        person.name.split(' ')[0],
    to_email:       email,
    exam_subject:   exam.syllabus,
    exam_component: exam.component || '',
    exam_date:      fmtDate(exam.date),
    exam_time:      exam.startTime,
    exam_room:      exam.room || 'TBC',
    finish_time:    exam.finishTime || 'TBC',
    ext_finish:     exam.extFinishTime || 'N/A',
    num_entries:    exam.entries || 'N/A', // 🌟 Added manual trigger variable payload here
    role,
    readiness_time: addMins(exam.startTime, -20),
  };
  await emailjs.send(s.ejsServiceId, s.ejsTemplateId, params);
  logEntry(exam, person.name, role, email, true, null);
}

/* ─── Manual send ──────────────────────────────────────────────── */

/* ─── Confirmation modal for manual notification ──────────────── */
function manualNotify(examId) {
  const exam = exams.find(e => e.id === examId);
  if (!exam) return;

  const people = [
    ...resolveAll(exam.invigRaw).map(p  => ({ ...p, role: 'Main Invigilator' })),
    ...resolveAll(exam.backupRaw).map(p => ({ ...p, role: 'Backup Invigilator' })),
  ];

  const recipientRows = people.length
    ? people.map(p => `
        <tr>
          <td style="padding:6px 10px;font-weight:600">${esc(p.name)}</td>
          <td style="padding:6px 10px;color:var(--text-2)">${esc(resolveEmail(p))}</td>
          <td style="padding:6px 10px"><span class="tag tag-invig">${p.role}</span></td>
        </tr>`).join('')
    : '<tr><td colspan="3" style="padding:10px;color:var(--text-3)">No invigilators assigned</td></tr>';

  document.getElementById('confirmNotifyBody').innerHTML = `
    <div style="margin-bottom:14px">
      <p style="margin:0 0 4px;font-weight:600;font-size:15px">${esc(exam.syllabus)}</p>
      <p style="margin:0;color:var(--text-2);font-size:13px">${fmtDate(exam.date)} · ${exam.startTime}${exam.room ? ' · Room ' + esc(exam.room) : ''}</p>
    </div>
    <p style="margin:0 0 8px;font-size:13px;font-weight:600">The following people will receive an email:</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid var(--border);border-radius:6px;overflow:hidden">
      <thead><tr style="background:var(--bg)">
        <th style="padding:6px 10px;text-align:left">Name</th>
        <th style="padding:6px 10px;text-align:left">Email</th>
        <th style="padding:6px 10px;text-align:left">Role</th>
      </tr></thead>
      <tbody>${recipientRows}</tbody>
    </table>`;

  const btn = document.getElementById('confirmNotifyBtn');
  btn.onclick = async () => {
    document.getElementById('confirmNotifyModal').classList.add('hidden');
    await _doManualNotify(examId);
  };
  btn.disabled = !people.length;

  document.getElementById('confirmNotifyModal').classList.remove('hidden');
}

async function _doManualNotify(examId) {
  const exam = exams.find(e => e.id === examId);
  if (!exam) return;

  if (!initEmailJS()) {
    showToast('Configure EmailJS in Settings first', 'error');
    return;
  }

  const s = getSettings();
  if (!s.ejsServiceId || !s.ejsTemplateId) {
    showToast('EmailJS not fully configured', 'error');
    return;
  }

  showToast('Sending…', '');

  let sent = 0;
  let failed = 0;

  for (const [raw, role, type] of [
    [exam.invigRaw,  'Main Invigilator',   'main'],
    [exam.backupRaw, 'Backup Invigilator', 'backup'],
  ]) {

    // Resolve ALL names in the field
    const people = resolveAll(raw);

    if (!people.length) continue;

    for (const person of people) {
      try {
        await sendOneEmail(exam, person, role);
        sent++;
      } catch (e) {
        logEntry(
          exam,
          person.name,
          role,
          resolveEmail(person),
          false,
          e.text || e.message
        );
        failed++;
      }

      await sleep(400);
    }

    // Mark group as notified once all sends complete
    if (type === 'main') {
      exam.notifiedMain = 'manual';
    }

    if (type === 'backup') {
      exam.notifiedBackup = 'manual';
    }
  }

  DB.set('exams', exams);

  renderDashboard();
  renderTimetable();
  renderLog();

  showToast(
    failed === 0
      ? `${sent} email(s) sent ✓`
      : `${sent} sent, ${failed} failed`,
    sent > 0 ? 'success' : 'error'
  );
}

/* --- Auto-note by Justice --- */
async function runTomorrowNotificationCheck() {
  const s = getSettings();

  if (!s.ejsPublicKey || !s.ejsServiceId || !s.ejsTemplateId) {
    return;
  }

  if (!initEmailJS()) {
    return;
  }

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  const tomorrowStr = tomorrow.toLocaleDateString('sv-SE', {
    timeZone: 'Europe/Warsaw'
  });

  let sent = 0;
  let failed = 0;

  for (const exam of exams) {

    if (exam.date !== tomorrowStr) continue;

    // Prevent duplicate sends
    if (exam.notifiedMain === 'tomorrow' &&
        exam.notifiedBackup === 'tomorrow') {
      continue;
    }

    for (const person of resolveAll(exam.invigRaw)) {
      try {
        await sendOneEmail(exam, person, 'Main Invigilator');
        sent++;
      } catch (e) {
        failed++;
      }

      await sleep(400);
    }

    for (const person of resolveAll(exam.backupRaw)) {
      try {
        await sendOneEmail(exam, person, 'Backup Invigilator');
        sent++;
      } catch (e) {
        failed++;
      }

      await sleep(400);
    }

    exam.notifiedMain = 'tomorrow';
    exam.notifiedBackup = 'tomorrow';
  }

  DB.set('exams', exams);

  console.log(
    `Tomorrow notifications complete: ${sent} sent, ${failed} failed`
  );
}

/* auto-daily-helper by Justice */
// Browser-side auto-scheduler removed.
// Automatic 7pm notifications are handled exclusively by GitHub Actions (notify.js)
// to prevent duplicate sends when the app is open on multiple devices simultaneously.
// Use the manual 📧 buttons or Settings → Run Check Now for on-demand sends.



/* ─── Automated check ─── */
async function runNotificationCheck() {
  const resultEl = document.getElementById('checkResult');
  const s = getSettings();
  if (!s.ejsPublicKey||!s.ejsServiceId||!s.ejsTemplateId) {
    showResult(resultEl,'❌ EmailJS not configured. Fill in Settings → EmailJS Config.','err'); return;
  }
  if (!initEmailJS()) { showResult(resultEl,'❌ EmailJS init failed. Check your Public Key.','err'); return; }

  showResult(resultEl,'⏳ Checking…','info');

  const today   = warsawTodayISO();
  const nowMins = warsawNowMinutes();
  const { notifyMinutes } = s;
  const toSend  = [];

  for (const exam of exams) {
    if (exam.date !== today) continue;
    const startMins  = parseTimeToMins(exam.startTime);
    if (startMins == null) continue;
    const minsUntil  = startMins - nowMins;
    if (minsUntil < notifyMinutes - 8 || minsUntil > notifyMinutes + 8) continue;

    if (!exam.notifiedMain) {
      resolveAll(exam.invigRaw).forEach(p =>
        toSend.push({ exam, person:p, role:'Main Invigilator', type:'main' })
      );
    }
    if (!exam.notifiedBackup) {
      resolveAll(exam.backupRaw).forEach(p =>
        toSend.push({ exam, person:p, role:'Backup Invigilator', type:'backup' })
      );
    }
  }

  if (!toSend.length) {
    showResult(resultEl,`✅ No notifications due right now. ${exams.length} exams checked — system fires ${notifyMinutes} min before each exam.`,'ok');
    return;
  }

  let sent=0, failed=0;
  for (const item of toSend) {
    try {
      await sendOneEmail(item.exam, item.person, item.role);
      const idx = exams.findIndex(e=>e.id===item.exam.id);
      if (idx!==-1) {
        if (item.type==='main')   exams[idx].notifiedMain   = true;
        if (item.type==='backup') exams[idx].notifiedBackup = true;
      }
      sent++;
    } catch(e) {
      logEntry(item.exam, item.person.name, item.role, resolveEmail(item.person), false, e.text||e.message);
      failed++;
    }
    await sleep(400);
  }
  DB.set('exams', exams);
  renderDashboard(); renderTimetable(); renderLog(); updateStats();
  showResult(resultEl,`✅ Sent ${sent}, Failed ${failed} of ${toSend.length} notifications.`, failed>0?'err':'ok');
}

async function sendTestEmail() {
  const resultEl = document.getElementById('emailTestResult');
  const s = getSettings();
  if (!s.ejsPublicKey||!s.ejsServiceId||!s.ejsTemplateId) {
    showResult(resultEl,'❌ Fill in all three EmailJS fields and Save first.','err'); return;
  }
  if (!initEmailJS()) { showResult(resultEl,'❌ EmailJS init failed.','err'); return; }
  showResult(resultEl,'⏳ Sending…','info');
  try {
    await emailjs.send(s.ejsServiceId, s.ejsTemplateId, {
      to_name:'Test User', to_email:'test@example.com',
      exam_subject:'TEST — Mathematics', exam_component:'Pure Mathematics 1',
      exam_date:fmtDate(warsawTodayISO()), exam_time:'10:00',
      exam_room:'5D', finish_time:'12:15', ext_finish:'12:49',
      role:'Main Invigilator', readiness_time:'09:40',
    });
    showResult(resultEl,'✅ Test email sent! Check the inbox configured in your EmailJS template.','ok');
  } catch(e) { showResult(resultEl,`❌ Failed: ${e.text||e.message}`,'err'); }
}

/* ═══════════════════════════════════════════════════════════════
   LOG
   ═══════════════════════════════════════════════════════════════ */
function logEntry(exam, name, role, email, success, errMsg) {
  notifLog.unshift({ ts:new Date().toISOString(), examDate:exam.date, examTime:exam.startTime,
    subject:exam.syllabus, name, role, email, success, error:errMsg||null });
  if (notifLog.length>500) notifLog=notifLog.slice(0,500);
  DB.set('notifLog', notifLog);
  renderLog(); updateStats();
}

function renderLog() {
  const el = document.getElementById('logContainer'); if (!el) return;
  if (!notifLog.length) { el.innerHTML='<p class="empty-state">No notifications sent yet.</p>'; return; }
  el.innerHTML = notifLog.map(e=>`
    <div class="log-entry">
      <div class="log-time">${fmtTs(e.ts)}</div>
      <div>
        <strong>${esc(e.name)}</strong> · ${esc(e.role)}<br/>
        <span style="color:var(--text-2);font-size:12px">${esc(e.subject)} · ${fmtDate(e.examDate)} ${e.examTime} · ${esc(e.email)}</span>
        ${e.error?`<br/><span style="color:var(--accent);font-size:11px">⚠ ${esc(e.error)}</span>`:''}
      </div>
      <div class="${e.success?'log-ok':'log-fail'}">${e.success?'✓ Sent':'✗ Failed'}</div>
    </div>`).join('');
}


/* ═══════════════════════════════════════════════════════════════
   TIMETABLE SAVE / ARCHIVE  (localStorage — no Firebase needed)
   ═══════════════════════════════════════════════════════════════ */

function saveTimetablePrompt() {
  const exams = DB.get('exams') || [];
  if (!exams.length) { showToast('No timetable to save — sync first', 'error'); return; }
  const defaultLabel = new Date().toLocaleDateString('en-GB', {month:'long', year:'numeric'}) + ' Exams';
  const label = prompt('Save this timetable with a label:', defaultLabel);
  if (!label) return;
  const archives = DB.get('archives') || [];
  archives.unshift({
    id: 'arch_' + Date.now(),
    label: label.trim(),
    savedAt: new Date().toISOString(),
    examCount: exams.length,
    exams: exams,
  });
  DB.set('archives', archives);
  showToast('Timetable archived ✓', 'success');
}

function loadArchiveList() {
  const el = document.getElementById('archiveContainer');
  if (!el) return;
  const archives = DB.get('archives') || [];
  if (!archives.length) {
    el.innerHTML = '<p class="empty-state">No saved timetables yet.<br/>Click "💾 Save Timetable" on the Dashboard or Timetable tab to save the current one.</p>';
    return;
  }
  el.innerHTML = archives.map(a => `
    <div class="archive-row">
      <div>
        <strong>${esc(a.label)}</strong>
        <div class="archive-meta">${a.examCount} exams · saved ${fmtTs(a.savedAt)}</div>
      </div>
      <button class="btn-ghost" style="font-size:12px" onclick="viewArchive('${a.id}')">👁 View</button>
      <button class="btn-ghost" style="font-size:12px" onclick="restoreArchive('${a.id}')">↩ Restore</button>
      <button class="btn-danger" onclick="deleteArchive('${a.id}', this)">🗑</button>
    </div>`).join('');
}

function viewArchive(id) {
  const archives = DB.get('archives') || [];
  const a = archives.find(x => x.id === id);
  if (!a) return;
  document.getElementById('archiveViewTitle').textContent = a.label + ' (' + a.examCount + ' exams)';
  document.getElementById('archiveViewContent').innerHTML = buildExamTableHTML(a.exams || []);
  document.getElementById('restoreArchiveBtn').onclick = () => restoreArchive(id);
  document.getElementById('archiveViewModal').classList.remove('hidden');
}

function restoreArchive(id) {
  if (!confirm('Restore this archived timetable as the active timetable? The current active timetable will be replaced.')) return;
  const archives = DB.get('archives') || [];
  const a = archives.find(x => x.id === id);
  if (!a || !a.exams) { showToast('Archive not found', 'error'); return; }
  DB.set('exams', a.exams);
  document.getElementById('archiveViewModal').classList.add('hidden');
  renderDashboard(); renderTimetable(); updateStats();
  showToast('Timetable restored ✓', 'success');
  showBanner('✅ Restored: ' + a.label + ' (' + a.exams.length + ' exams)', 'ok');
}

function deleteArchive(id, btn) {
  if (!confirm('Permanently delete this archived timetable?')) return;
  let archives = DB.get('archives') || [];
  archives = archives.filter(x => x.id !== id);
  DB.set('archives', archives);
  btn.closest('.archive-row').remove();
  const archives2 = DB.get('archives') || [];
  if (!archives2.length) loadArchiveList();
  showToast('Deleted');
}

function buildExamTableHTML(list) {
  if (!list.length) return '<p class="empty-state">No exams in this archive.</p>';
  return `<table class="data-table" style="font-size:12px">
    <thead><tr>
      <th>Date</th><th>Start</th><th>Finish</th><th>Ext End</th>
      <th>Subject</th><th>Component</th><th>Room</th><th>Students</th>
      <th>Main Invigilator</th><th>Backup</th>
    </tr></thead>
    <tbody>${list.map(e => `<tr>
      <td>${fmtDate(e.date)}</td>
      <td>${e.startTime}</td>
      <td>${e.finishTime || '—'}</td>
      <td>${e.extFinishTime || '—'}</td>
      <td>${esc(e.syllabus)}</td>
      <td style="color:var(--text-2)">${esc(e.component || '')}</td>
      <td>${esc(e.room || '—')}</td>
      <td>${e.entries || '—'}</td>
      <td>${esc(e.invigRaw || '—')}</td>
      <td>${esc(e.backupRaw || '—')}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

/* ═══════════════════════════════════════════════════════════════
   COMPILE — per-invigilator schedule + PDF download + email
   ═══════════════════════════════════════════════════════════════ */

let _compileInvigId = null;

function compileInvigilator(invId) {
  const inv = invigilators.find(i => i.id === invId);
  if (!inv) return;
  _compileInvigId = invId;

  const exams = DB.get('exams') || [];
  // Find all exams where this invigilator appears (main or backup, any position in multi-list)
  const myExams = exams.filter(e => {
    const aliases = inv.aliases.map(a => a.toLowerCase().replace(/\/+$/, '').trim());
    const matchName = raw => splitNames(raw).some(n => {
      const nl = n.toLowerCase().replace(/\/+$/, '').trim();
      return aliases.includes(nl) ||
        inv.name.split(' ')[0].toLowerCase() === nl.split(' ')[0].toLowerCase();
    });
    return matchName(e.invigRaw) || matchName(e.backupRaw);
  }).sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

  document.getElementById('compileTitle').textContent =
    inv.name + ' — Invigilation Schedule (' + myExams.length + ' assignments)';

  if (!myExams.length) {
    document.getElementById('compileContent').innerHTML =
      '<p class="empty-state">No invigilation assignments found for ' + esc(inv.name) + ' in the current timetable.<br/>Make sure the sheet aliases match the names in the timetable.</p>';
  } else {
    const rows = myExams.map(e => {
      const aliases = inv.aliases.map(a => a.toLowerCase().replace(/\/+$/, '').trim());
      const isMain = splitNames(e.invigRaw).some(n => {
        const nl = n.toLowerCase().replace(/\/+$/, '').trim();
        return aliases.includes(nl) ||
          inv.name.split(' ')[0].toLowerCase() === nl.split(' ')[0].toLowerCase();
      });
      const dayName = new Date(e.date + 'T12:00:00Z')
        .toLocaleDateString('en-GB', {weekday:'long', timeZone:'UTC'});
      return `<tr>
        <td>${fmtDate(e.date)}</td>
        <td>${dayName}</td>
        <td>${esc(e.syllabus)}</td>
        <td style="color:var(--text-2);font-size:11px">${esc(e.component || '')}</td>
        <td>${esc(e.code || '—')}</td>
        <td>${esc(e.room || '—')}</td>
        <td>${e.startTime}</td>
        <td>${e.finishTime || '—'}</td>
        <td>${e.extFinishTime || '—'}</td>
        <td>${e.entries || '—'}</td>
        <td><strong>${isMain ? 'Main' : 'Backup'}</strong></td>
      </tr>`;
    }).join('');

    document.getElementById('compileContent').innerHTML = `
      <p style="padding:4px 0 12px;font-size:13px;color:var(--text-2)">
        <strong>${esc(inv.name)}</strong> · ${esc(resolveEmail(inv))} · ${myExams.length} assignment(s)
      </p>
      <div style="overflow-x:auto">
      <table class="compile-table">
        <thead><tr>
          <th>Date</th><th>Day</th><th>Subject</th><th>Component</th>
          <th>Code</th><th>Venue</th><th>Start</th><th>Finish</th>
          <th>Ext. End</th><th>Students</th><th>Role</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }
  document.getElementById('compileModal').classList.remove('hidden');
}

function closeCompileModal() {
  document.getElementById('compileModal').classList.add('hidden');
  _compileInvigId = null;
}

function _buildPDF(inv, myExams) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const aliases = inv.aliases.map(a => a.toLowerCase().replace(/\/+$/, '').trim());
  const isMain = e => splitNames(e.invigRaw).some(n => {
    const nl = n.toLowerCase().replace(/\/+$/, '').trim();
    return aliases.includes(nl) ||
      inv.name.split(' ')[0].toLowerCase() === nl.split(' ')[0].toLowerCase();
  });

  // Header
  doc.setFontSize(18); doc.setFont('helvetica','bold');
  doc.text('REGENT COLLEGE INTERNATIONAL SCHOOLS', 14, 16);
  doc.setFontSize(12); doc.setFont('helvetica','normal');
  doc.text('Invigilation Schedule: ' + inv.name, 14, 24);
  doc.setFontSize(9); doc.setTextColor(120);
  doc.text('Email: ' + resolveEmail(inv) + '   |   Assignments: ' + myExams.length +
    '   |   Generated: ' + new Date().toLocaleDateString('en-GB',
      {weekday:'long',day:'numeric',month:'long',year:'numeric'}), 14, 30);
  doc.setTextColor(0);

  // Table
  doc.autoTable({
    startY: 36,
    head: [['Date','Day','Subject','Component','Code','Room','Start','Finish','Ext. End','Students','Role']],
    body: myExams.map(e => {
      const day = new Date(e.date+'T12:00:00Z')
        .toLocaleDateString('en-GB',{weekday:'short',timeZone:'UTC'});
      return [
        fmtDate(e.date), day,
        e.syllabus, e.component || '', e.code || '', e.room || '',
        e.startTime, e.finishTime || '—', e.extFinishTime || '—',
        e.entries || '—', isMain(e) ? 'Main' : 'Backup'
      ];
    }),
    styles: { fontSize: 8, cellPadding: 2.5 },
    headStyles: { fillColor: [26, 26, 46], fontSize: 8, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [247, 246, 242] },
    columnStyles: { 2: { cellWidth: 38 }, 3: { cellWidth: 32 } },
    margin: { left: 14, right: 14 },
  });

  // Footer on every page
  const total = doc.internal.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    doc.setFontSize(7); doc.setTextColor(160);
    doc.text(
      'Regent College International Schools · ' + inv.name + ' · CONFIDENTIAL · Page ' + p + ' of ' + total,
      doc.internal.pageSize.width / 2,
      doc.internal.pageSize.height - 5,
      { align: 'center' }
    );
  }
  return doc;
}

function _getCompileExams(inv) {
  const exams = DB.get('exams') || [];
  const aliases = inv.aliases.map(a => a.toLowerCase().replace(/\/+$/, '').trim());
  const matchName = raw => splitNames(raw).some(n => {
    const nl = n.toLowerCase().replace(/\/+$/, '').trim();
    return aliases.includes(nl) ||
      inv.name.split(' ')[0].toLowerCase() === nl.split(' ')[0].toLowerCase();
  });
  return exams
    .filter(e => matchName(e.invigRaw) || matchName(e.backupRaw))
    .sort((a,b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
}

function downloadPDF() {
  const inv = invigilators.find(i => i.id === _compileInvigId);
  if (!inv) return;
  const myExams = _getCompileExams(inv);
  if (!myExams.length) { showToast('No assignments to generate PDF for', 'error'); return; }
  try {
    const doc = _buildPDF(inv, myExams);
    doc.save(inv.name.replace(/\s+/g,'_') + '_Invigilation_Schedule.pdf');
    showToast('PDF downloaded ✓', 'success');
  } catch(e) { showToast('PDF error: ' + e.message, 'error'); console.error(e); }
}


/* ─── Preview modal for PDF email ─────────────────────────────── */
async function emailPDF() {
  const inv = invigilators.find(i => i.id === _compileInvigId);
  if (!inv) return;
  const myExams = _getCompileExams(inv);
  if (!myExams.length) { showToast('No assignments to preview', 'error'); return; }

  const aliases = inv.aliases.map(a => a.toLowerCase().replace(/\/+$/, '').trim());
  const isMain = e => splitNames(e.invigRaw).some(n => {
    const nl = n.toLowerCase().replace(/\/+$/, '').trim();
    return aliases.includes(nl) || inv.name.split(' ')[0].toLowerCase() === nl.split(' ')[0].toLowerCase();
  });

  const previewRows = myExams.map(e => `
    <tr style="border-bottom:1px solid var(--border)">
      <td style="padding:8px;font-weight:600">${fmtDate(e.date)}</td>
      <td style="padding:8px">${esc(e.syllabus)}</td>
      <td style="padding:8px;color:var(--text-2);font-size:12px">${esc(e.component||'—')}</td>
      <td style="padding:8px">${esc(e.room||'—')}</td>
      <td style="padding:8px">${e.startTime}</td>
      <td style="padding:8px">${e.finishTime||'—'}</td>
      <td style="padding:8px"><strong>${isMain(e)?'Main':'Backup'}</strong></td>
    </tr>`).join('');

  document.getElementById('emailPdfPreviewBody').innerHTML = `
    <div style="padding:16px 20px;background:var(--bg);border-bottom:1px solid var(--border)">
      <p style="margin:0 0 2px;font-size:13px;color:var(--text-2)">Sending to:</p>
      <p style="margin:0;font-weight:600;font-size:15px">${esc(inv.name)}</p>
      <p style="margin:2px 0 0;font-size:13px;color:var(--text-2)">${esc(resolveEmail(inv))}</p>
    </div>
    <div style="padding:16px 20px">
      <p style="margin:0 0 10px;font-size:13px;font-weight:600">Email will contain this schedule (${myExams.length} exam${myExams.length>1?'s':''}) plus a PDF attachment:</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid var(--border)">
        <thead><tr style="background:#740001;color:#eeba30;text-align:left">
          <th style="padding:8px">Date</th>
          <th style="padding:8px">Subject</th>
          <th style="padding:8px">Component</th>
          <th style="padding:8px">Room</th>
          <th style="padding:8px">Start</th>
          <th style="padding:8px">Finish</th>
          <th style="padding:8px">Role</th>
        </tr></thead>
        <tbody>${previewRows}</tbody>
      </table>
    </div>`;

  document.getElementById('confirmEmailPdfBtn').onclick = async () => {
    document.getElementById('emailPdfPreviewModal').classList.add('hidden');
    await _doEmailPDF();
  };

  document.getElementById('emailPdfPreviewModal').classList.remove('hidden');
}

async function _doEmailPDF() {
  const inv = invigilators.find(i => i.id === _compileInvigId);
  if (!inv) return;
  const myExams = _getCompileExams(inv);
  if (!myExams.length) { showToast('No assignments to email', 'error'); return; }

  const s = getSettings();
  const templateId = s.ejsScheduleTemplateId || s.ejsTemplateId;
  if (!s.ejsPublicKey || !s.ejsServiceId || !templateId) {
    showToast('Configure EmailJS settings first', 'error'); return;
  }
  if (!initEmailJS()) { showToast('EmailJS init failed — check Public Key', 'error'); return; }

  showToast('Generating PDF and sending…', '');
  try {
    // Download PDF locally as backup
    const doc = _buildPDF(inv, myExams);
    doc.save(inv.name.replace(/\s+/g,'_') + '_Invigilation_Schedule.pdf');

    // Build HTML schedule table for email body
    const aliases = inv.aliases.map(a => a.toLowerCase().replace(/\/+$/, '').trim());
    const isMain = e => splitNames(e.invigRaw).some(n => {
      const nl = n.toLowerCase().replace(/\/+$/, '').trim();
      return aliases.includes(nl) || inv.name.split(' ')[0].toLowerCase() === nl.split(' ')[0].toLowerCase();
    });

    const tableRowsHtml = myExams.map(e => {
      const day = new Date(e.date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday:'short', timeZone:'UTC' });
      return `<tr style="border-bottom:1px solid #ddd;">
        <td style="padding:8px;font-weight:bold">${fmtDate(e.date)} (${day})</td>
        <td style="padding:8px">${esc(e.syllabus)}</td>
        <td style="padding:8px">${esc(e.room||'—')}</td>
        <td style="padding:8px">${e.startTime}</td>
        <td style="padding:8px">${e.finishTime||'—'}</td>
        <td style="padding:8px"><strong>${isMain(e)?'Main':'Backup'}</strong></td>
      </tr>`;
    }).join('');

    const inlineTableHtml = `
      <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;margin-top:15px">
        <thead><tr style="background-color:#740001;color:#fff;text-align:left">
          <th style="padding:8px">Date</th><th style="padding:8px">Subject</th>
          <th style="padding:8px">Venue</th><th style="padding:8px">Start</th>
          <th style="padding:8px">Finish</th><th style="padding:8px">Role</th>
        </tr></thead>
        <tbody>${tableRowsHtml}</tbody>
      </table>`;

    await emailjs.send(s.ejsServiceId, templateId, {
      to_name:           inv.name.split(' ')[0],
      to_email:          resolveEmail(inv),
      total_assignments: myExams.length,
      html_schedule:     inlineTableHtml,
    });

    showToast('PDF downloaded & schedule email sent ✓', 'success');
  } catch(e) {
    showToast('Error: ' + (e.text || e.message), 'error');
    console.error(e);
  }
}

function clearLog() {
  if (!confirm('Clear all logs?')) return;
  notifLog=[]; DB.set('notifLog', notifLog); renderLog(); showToast('Log cleared');
}

/* ═══════════════════════════════════════════════════════════════
   SETTINGS
   ═══════════════════════════════════════════════════════════════ */
function loadSettingsUI() {
  const s = getSettings();
  setV('sheetsUrl',s.sheetsUrl); setV('sheetsGid',s.sheetsGid);
  setV('ejsPublicKey',s.ejsPublicKey); setV('ejsServiceId',s.ejsServiceId); setV('ejsTemplateId',s.ejsTemplateId); setV('ejsScheduleTemplateId',s.ejsScheduleTemplateId||''); setV('workerUrl',s.workerUrl||'');
  setV('notifyMinutes',s.notifyMinutes); setV('emailDomain',s.emailDomain); setV('timezone',s.timezone);
}
function saveSheetSettings()  { saveSettings({sheetsUrl:getV('sheetsUrl'),sheetsGid:getV('sheetsGid'), ejsScheduleTemplateId: getV('ejsScheduleTemplateId')}); showToast('Sheet settings saved ✓','success'); }
function saveEmailSettings()  { saveSettings({ejsPublicKey:getV('ejsPublicKey'),ejsServiceId:getV('ejsServiceId'),ejsTemplateId:getV('ejsTemplateId'),ejsScheduleTemplateId:getV('ejsScheduleTemplateId'),workerUrl:getV('workerUrl')}); showToast('Email settings saved ✓','success'); }
function saveNotifSettings()  { saveSettings({notifyMinutes:parseInt(getV('notifyMinutes'))||60,emailDomain:getV('emailDomain'),timezone:getV('timezone')}); renderInvigilators(); showToast('Rules saved ✓','success'); }

function changePin() {
  const resultEl = document.getElementById('pinResult');
  const s        = getSettings();
  const current  = document.getElementById('currentPin').value;
  const newPin   = document.getElementById('newPin').value;
  const confirm  = document.getElementById('confirmPin').value;
  if (current!==String(s.pin))     { showResult(resultEl,'❌ Current PIN is incorrect.','err'); return; }
  if (newPin.length<4)             { showResult(resultEl,'❌ PIN must be at least 4 digits.','err'); return; }
  if (!/^\d+$/.test(newPin))       { showResult(resultEl,'❌ PIN must be digits only.','err'); return; }
  if (newPin!==confirm)            { showResult(resultEl,'❌ PINs do not match.','err'); return; }
  saveSettings({pin:newPin});
  ['currentPin','newPin','confirmPin'].forEach(id=>{ document.getElementById(id).value=''; });
  showResult(resultEl,'✅ PIN changed successfully.','ok');
}

/* ═══════════════════════════════════════════════════════════════
   STATS
   ═══════════════════════════════════════════════════════════════ */
function updateStats() {
  const today = warsawTodayISO();
  setTxt('statToday',     exams.filter(e=>e.date===today).length);
  setTxt('statSentToday', notifLog.filter(l=>l.ts.startsWith(today.substring(0,10))&&l.success).length);
  setTxt('statInvig',     invigilators.filter(i=>i.active).length);
  setTxt('statTotal',     exams.length);
}

/* ═══════════════════════════════════════════════════════════════
   UI HELPERS
   ═══════════════════════════════════════════════════════════════ */
function showBanner(msg, type) {
  const el = document.getElementById('syncBanner'); if (!el) return;
  el.innerHTML = msg.replace(/\n/g,'<br/>');
  el.className = `sync-banner show ${type}`;
}
function showResult(el, msg, type) {
  if (!el) return;
  el.innerHTML = msg.replace(/\n/g,'<br/>');
  el.className = `result-box show ${type}`;
}
let _toastT;
function showToast(msg, type='') {
  const t = document.getElementById('toast'); if (!t) return;
  t.textContent=msg; t.className=`toast ${type}`; t.classList.remove('hidden');
  clearTimeout(_toastT); _toastT=setTimeout(()=>t.classList.add('hidden'), 3400);
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');
}
function fmtDate(d) {
  try { return new Date(d+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}); }
  catch { return d; }
}
function fmtTs(ts) {
  try {
    const d=new Date(ts);
    return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'Europe/Warsaw'})
      +' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Warsaw'});
  } catch { return ts; }
}
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }
function getV(id)    { return (document.getElementById(id)?.value||'').trim(); }
function setV(id,v)  { const el=document.getElementById(id); if(el) el.value=v??''; }
function setTxt(id,v){ const el=document.getElementById(id); if(el) el.textContent=v; }


/* ─── Daily Summary ────────────────────────────────────────────── */
/* ─── Daily Summary with day navigator ────────────────────────── */
let _summaryViewDate = null;   // currently displayed date in summary modal

function showDailySummary() {
  const today = warsawTodayISO ? warsawTodayISO() : new Date().toLocaleDateString('sv-SE');
  _summaryViewDate = today;
  _renderSummaryForDate(_summaryViewDate);
  document.getElementById('dailySummaryModal').classList.remove('hidden');
}

function _summaryUniqueDates() {
  // All distinct exam dates sorted ascending
  return [...new Set(exams.map(e => e.date))].sort();
}

function _renderSummaryForDate(dateStr) {
  const today = warsawTodayISO ? warsawTodayISO() : new Date().toLocaleDateString('sv-SE');
  const allDates   = _summaryUniqueDates();
  const dateExams  = exams.filter(e => e.date === dateStr).sort((a,b) => a.startTime.localeCompare(b.startTime));
  const curIdx     = allDates.indexOf(dateStr);
  const prevDate   = curIdx > 0 ? allDates[curIdx - 1] : null;
  const nextDate   = allDates.find(d => d > dateStr) || null;

  const dateLabel = new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-GB', {
    weekday:'long', day:'numeric', month:'long', year:'numeric', timeZone:'UTC'
  });

  const isToday   = dateStr === today;
  const totalCand = dateExams.reduce((s,e) => s + (parseInt(e.entries)||0), 0);

  function buildTable(list) {
    if (!list.length) return '<p style="color:var(--text-3);padding:16px 20px;margin:0">No exams on this day.</p>';
    const rows = list.map((e, i) => {
      const invigs  = resolveAll(e.invigRaw).map(p  => esc(p.name)).join(', ') || '—';
      const backups = resolveAll(e.backupRaw).map(p => esc(p.name)).join(', ') || '—';
      const st = examStatus(e);
      return `<tr style="background:${i%2===0?'var(--surface)':'var(--bg)'}">
        <td style="padding:10px 14px;font-weight:700;white-space:nowrap">${e.startTime}</td>
        <td style="padding:10px 14px;white-space:nowrap">${e.finishTime||'—'}</td>
        <td style="padding:10px 14px;font-weight:600">${esc(e.syllabus)}</td>
        <td style="padding:10px 14px;color:var(--text-2);font-size:12px">${esc(e.component||'—')}</td>
        <td style="padding:10px 14px"><span class="tag tag-room">${esc(e.room||'—')}</span></td>
        <td style="padding:10px 14px">${invigs}</td>
        <td style="padding:10px 14px;color:var(--text-2)">${backups}</td>
        <td style="padding:10px 14px;text-align:center"><strong>${esc(e.entries||'—')}</strong></td>
        <td style="padding:10px 14px"><span class="exam-status ${st.cls}">${st.label}</span></td>
      </tr>`;
    }).join('');
    return `<div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#740001;color:#eeba30;text-align:left">
          <th style="padding:10px 14px">Start</th>
          <th style="padding:10px 14px">Finish</th>
          <th style="padding:10px 14px">Subject</th>
          <th style="padding:10px 14px">Component</th>
          <th style="padding:10px 14px">Room</th>
          <th style="padding:10px 14px">Main Invigilator</th>
          <th style="padding:10px 14px">Backup</th>
          <th style="padding:10px 14px;text-align:center">Entries</th>
          <th style="padding:10px 14px">Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  // Nav buttons
  const prevBtn = prevDate
    ? `<button class="btn-ghost" onclick="_navSummary('${prevDate}')">◀ Prev Exam Day</button>`
    : `<button class="btn-ghost" disabled style="opacity:.4">◀ Prev Exam Day</button>`;
  const nextBtn = nextDate
    ? `<button class="btn-primary" onclick="_navSummary('${nextDate}')">Next Exam Day ▶</button>`
    : `<button class="btn-primary" disabled style="opacity:.4">Next Exam Day ▶</button>`;
  const todayBtn = !isToday
    ? `<button class="btn-ghost" onclick="_navSummary('${today}')">📅 Back to Today</button>`
    : '';

  document.getElementById('dailySummaryTitle').textContent =
    (isToday ? 'Today — ' : '') + dateLabel;

  document.getElementById('dailySummaryBody').innerHTML = `
    <div style="padding:12px 20px;background:var(--bg);border-bottom:1px solid var(--border);display:flex;gap:20px;flex-wrap:wrap;align-items:center">
      <span style="font-size:13px"><strong>${dateExams.length}</strong> exam${dateExams.length!==1?'s':''}</span>
      <span style="font-size:13px"><strong>${totalCand}</strong> candidate${totalCand!==1?'s':''}</span>
      <span style="flex:1"></span>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${prevBtn}${todayBtn}${nextBtn}
      </div>
    </div>
    ${buildTable(dateExams)}`;
}

function _navSummary(dateStr) {
  _summaryViewDate = dateStr;
  _renderSummaryForDate(dateStr);
}

function printDailySummary() {
  const body  = document.getElementById('dailySummaryBody').innerHTML;
  const title = document.getElementById('dailySummaryTitle').textContent;
  const win   = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>${title}</title>
    <style>
      body{font-family:Arial,sans-serif;padding:24px;font-size:12px}
      h2{color:#740001;margin-bottom:16px}
      table{width:100%;border-collapse:collapse}
      th{background:#740001;color:#eeba30;padding:8px 10px;text-align:left}
      td{padding:8px 10px;border-bottom:1px solid #ddd}
      tr:nth-child(even) td{background:#f9f9f9}
      .exam-status{font-size:11px;padding:2px 6px;border-radius:4px}
      .tag-room{background:#e8f4fd;color:#1a5276;padding:2px 6px;border-radius:4px;font-size:11px}
      button{display:none}
    </style></head>
    <body><h2>${title}</h2>${body}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
}

