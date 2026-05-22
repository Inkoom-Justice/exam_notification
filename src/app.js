/* ═══════════════════════════════════════════════════════════════
   REGENT EXAM NOTIFIER — app.js
   Warsaw timezone · finish/ext-time status · auto notifications
   ═══════════════════════════════════════════════════════════════ */
'use strict';

/* ─── STORAGE ──────────────────────────────────────────────────── */
const S = {
  get(k)    { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) { console.error(e); } },
};

/* ─── DEFAULTS ─────────────────────────────────────────────────── */
const DEFAULT_SETTINGS = {
  sheetsUrl:'', sheetsGid:'1559134635',
  ejsPublicKey:'', ejsServiceId:'', ejsTemplateId:'',
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
let exams        = S.get('exams')        || [];
let invigilators = S.get('invigilators') || DEFAULT_INVIGILATORS;
let notifLog     = S.get('notifLog')     || [];
let editingId    = null;

function getSettings() {
  return Object.assign({}, DEFAULT_SETTINGS, S.get('settings') || {});
}
function saveSettings(patch) {
  S.set('settings', Object.assign(getSettings(), patch));
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

/** Parse "HH:MM:SS" or "HH:MM" → total minutes since midnight. Returns null if unparseable. */
function parseTimeToMins(raw) {
  if (!raw) return null;
  const s = raw.toString().trim();
  if (/^\d+\.\d+$/.test(s)) {
    const frac = parseFloat(s);
    return Math.round(frac * 24 * 60);
  }
  const match = s.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return parseInt(match[1]) * 60 + parseInt(match[2]);
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
  const pinInput = document.getElementById('pinInput');
  const errEl    = document.getElementById('loginErr');
  const pin      = (pinInput.value || '').trim();
  errEl.textContent = '';
  if (!pin) { errEl.textContent = 'Please enter your PIN.'; return; }
  if (pin === String(getSettings().pin)) {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    pinInput.value = '';
    initApp();
  } else {
    errEl.textContent = 'Incorrect PIN — please try again.';
    pinInput.value = ''; pinInput.focus();
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
function initApp() {
  loadSettingsUI();
  renderInvigilators();
  renderDashboard();
  renderTimetable();
  renderLog();
  updateStats();
  setInterval(() => { renderDashboard(); renderTimetable(); updateStats(); }, 60000);
}

function switchTab(name, el) {
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const sec = document.getElementById('tab-' + name);
  if (sec) sec.classList.add('active');
  if (el)  el.classList.add('active');
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

function resolveInvigilator(rawName) {
  if (!rawName) return null;
  const cleaned = rawName.toString().replace(/\/+$/, '').trim();
  if (!cleaned || cleaned === '-' || cleaned.toLowerCase() === 'nan') return null;
  const found = invigilators.find(inv =>
    inv.active && inv.aliases.some(a => a.trim().toLowerCase() === cleaned.toLowerCase())
  );
  if (found) return found;
  const partial = invigilators.find(inv =>
    inv.active && inv.name.split(' ')[0].toLowerCase() === cleaned.split(' ')[0].toLowerCase()
  );
  if (partial) return partial;
  return { id:null, name:cleaned, email:'', aliases:[], active:true };
}

/* ═══════════════════════════════════════════════════════════════
   CORS PROXY FETCH
   ═══════════════════════════════════════════════════════════════ */
const PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  url => `https://thingproxy.freeboard.io/fetch/${url}`,
];
const PROXY_NAMES = ['corsproxy.io','codetabs.com','allorigins.win','thingproxy'];

async function proxyFetch(csvUrl, onProgress) {
  let lastErr = 'Unknown';
  for (let i = 0; i < PROXIES.length; i++) {
    if (onProgress) onProgress(`Trying proxy ${i+1}/4: ${PROXY_NAMES[i]}…`);
    try {
      const ctrl = new AbortController();
      const t    = setTimeout(() => ctrl.abort(), 10000);
      const res  = await fetch(PROXIES[i](csvUrl), { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      try { const j = JSON.parse(text); if (j && j.contents) return { csv:j.contents, proxy:PROXY_NAMES[i] }; } catch {}
      if (text.includes(',') && text.split('\n').length > 2) return { csv:text, proxy:PROXY_NAMES[i] };
      throw new Error('Response is not CSV');
    } catch(e) { lastErr = e.name === 'AbortError' ? 'Timed out' : e.message; }
  }
  throw new Error(`All proxies failed. Last: ${lastErr}`);
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
  const rows = [];
  for (const line of csv.split('\n')) {
    const row = []; let inQ=false, cell='';
    for (const ch of line) {
      if (ch==='"') { inQ=!inQ; }
      else if (ch===',' && !inQ) { row.push(cell.trim()); cell=''; }
      else { cell+=ch; }
    }
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}

function parseTimetableCSV(csv) {
  const rows = csvToRows(csv);
  let hi = -1;
  for (let i=0; i<rows.length; i++) {
    const r = rows[i].map(c=>(c||'').toLowerCase());
    if (r.some(c=>c.includes('start time')) && r.some(c=>c.includes('invigilator'))) { hi=i; break; }
  }
  if (hi===-1) { showBanner('❌ Header row not found. Check the sheet tab is correct.','err'); return 0; }

  const H   = rows[hi].map(c=>(c||'').toLowerCase().trim());
  const col = kw => H.findIndex(h => h.includes(kw.toLowerCase()));

  const C = {
    date:         col('exam date'),
    room:         col('room'),
    session:      col('session'),
    start:        col('start time'),
    readiness:    col('full-readiness'),
    duration:     col('duration in min'),
    finish:       col('finish time'),
    extMins:      col('ext. time in min'),
    extFinish:    col('ext. finish time'),
    extFor:       col('extended time for'),
    entries:      col('entries'),          // 🌟 Added configuration map marker
    invig:        col('exam invigilator'),
    backup:       col('backup invigilator'),
    comments:     col('comments'),
    syllabus:     col('syllabus'),
    component:    col('component title'),
    code:         col('code'),
  };

  const existing = new Map(exams.map(e=>[e.id,e]));
  const parsed   = [];

  for (let i=hi+1; i<rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(c=>!c)) continue;

    const rawDate   = (r[C.date]     ||'').toString().trim();
    const rawStart  = (r[C.start]    ||'').toString().trim();
    const syllabus  = (r[C.syllabus] ||'').toString().trim();
    if (!rawDate || !rawStart || !syllabus || rawDate==='NaN') continue;

    let dateStr = '';
    const raw = rawDate.toString().trim();

    if (/^\d{4}-\d{2}-\d{2}[T \d]/.test(raw)) {
      dateStr = raw.substring(0, 10);
    }
    else if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
      const [d, m, y] = raw.split('/');
      dateStr = `${y}-${m}-${d}`;
    }
    else if (/^\d{2}\/\d{2}\/\d{2}$/.test(raw)) {
      const [d, m, y] = raw.split('/');
      dateStr = `20${y}-${m}-${d}`;
    }
    else if (/^\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4}$/.test(raw)) {
      const months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
                      jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
      const parts  = raw.split(/\s+/);
      const day    = parts[0].padStart(2,'0');
      const mon    = months[parts[1].toLowerCase().substring(0,3)] || '01';
      const yr     = parts[2].length === 2 ? '20' + parts[2] : parts[2];
      dateStr      = `${yr}-${mon}-${day}`;
    }
    else if (/^\d{5}$/.test(raw)) {
      const serial = parseInt(raw) - (parseInt(raw) > 59 ? 1 : 0);
      const excelEpoch = new Date(Date.UTC(1899, 11, 31));
      const ms = excelEpoch.getTime() + serial * 86400000;
      const d  = new Date(ms);
      dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    }

    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

    const startMins = parseTimeToMins(rawStart);
    if (startMins == null) continue;
    const startTime = minsToTime(startMins);

    const finishRaw    = C.finish    >= 0 ? (r[C.finish]    ||'').toString().trim() : '';
    const extFinishRaw = C.extFinish >= 0 ? (r[C.extFinish] ||'').toString().trim() : '';
    const extMinsRaw   = C.extMins   >= 0 ? (r[C.extMins]   ||'').toString().trim() : '';

    const finishMins   = parseTimeToMins(finishRaw);
    let   extFinishMins= parseTimeToMins(extFinishRaw);

    if (extFinishMins == null && finishMins != null && extMinsRaw && extMinsRaw !== '-') {
      const em = parseFloat(extMinsRaw);
      if (!isNaN(em) && em > 0) extFinishMins = finishMins + Math.round(em);
    }

    const finishTime    = finishMins    != null ? minsToTime(finishMins)    : '';
    const extFinishTime = extFinishMins != null ? minsToTime(extFinishMins) : '';

    const code    = C.code>=0    ? (r[C.code]   ||'').toString().trim() : '';
    const id      = `exam_${dateStr}_${startTime}_${(code||syllabus).replace(/\W/g,'_')}`;
    const prev    = existing.get(id);

    // Fetch status trackers explicitly matching historical structural configuration labels
    let logMain = false;
    let logBackup = false;
    try {
      // Attempt retrieval from cross-synced repository trackers
      const globalSentLog = S.get('notifLog') || [];
      // Or pull directly from locally updated cache
      if (prev) {
        logMain = prev.notifiedMain;
        logBackup = prev.notifiedBackup;
      }
    } catch(e){}

    parsed.push({
      id, date:dateStr, startTime, finishTime, extFinishTime,
      room:      C.room>=0      ? (r[C.room]     ||'').toString().trim() : '',
      session:   C.session>=0   ? (r[C.session]  ||'').toString().trim() : '',
      syllabus,
      component: C.component>=0 ? (r[C.component]||'').toString().trim() : '',
      code,
      extFor:    C.extFor>=0    ? (r[C.extFor]   ||'').toString().trim() : '',
      entries:   C.entries>=0   ? (r[C.entries]  ||'').toString().trim() : '',
      invigRaw:  C.invig>=0     ? (r[C.invig]    ||'').toString().trim() : '',
      backupRaw: C.backup>=0    ? (r[C.backup]   ||'').toString().trim() : '',
      comments:  C.comments>=0  ? (r[C.comments] ||'').toString().trim() : '',
      notifiedMain:   logMain,
      notifiedBackup: logBackup,
    });
  }

  exams = parsed;
  S.set('exams', exams);
  renderDashboard(); renderTimetable(); updateStats();
  showToast(`${exams.length} exams loaded`,'success');
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
  renderExamCards('upcomingExams', exams.filter(e=>e.date>today && e.date<=limitStr),   false);
}

function renderExamCards(id, list, showBtn) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!list.length) { el.innerHTML='<p class="empty-state">Nothing here.</p>'; return; }
  el.innerHTML = list.map(exam => {
    const st     = examStatus(exam);
    const invig  = resolveInvigilator(exam.invigRaw);
    const backup = resolveInvigilator(exam.backupRaw);
    const times  = buildTimeline(exam);
    return `
    <div class="exam-card">
      <div class="exam-time-badge">${exam.startTime}<span class="session-tag">${exam.session||'—'}</span></div>
      <div class="exam-info">
        <div class="exam-subject">${esc(exam.syllabus)}</div>
        <div class="exam-component">${esc(exam.component)}</div>
        <div class="exam-meta">
          ${exam.room    ? `<span class="tag tag-room">📍 ${esc(exam.room)}</span>`    : ''}
          ${invig        ? `<span class="tag tag-invig">👤 ${esc(invig.name)}</span>`  : ''}
          ${backup       ? `<span class="tag tag-backup">🔁 ${esc(backup.name)}</span>`: ''}
          ${times        ? `<span class="tag tag-time">${times}</span>`                : ''}
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
  <table class="data-table">
    <thead><tr>
      <th>Date</th><th>Start</th><th>Finish</th><th>Ext. End</th>
      <th>Session</th><th>Subject</th><th>Component</th>
      <th>Entries</th> <th>Room</th>
      <th>Main Invigilator</th><th>Backup</th><th>Status</th><th></th>
    </tr></thead>
    <tbody>${list.map(e => {
      const st     = examStatus(e);
      const invig  = resolveInvigilator(e.invigRaw);
      const backup = resolveInvigilator(e.backupRaw);
      return `<tr>
        <td><strong>${fmtDate(e.date)}</strong></td>
        <td>${e.startTime}</td>
        <td>${e.finishTime    || '—'}</td>
        <td>${e.extFinishTime ? `<span class="tag tag-ext">${e.extFinishTime}</span>` : '—'}</td>
        <td>${esc(e.session||'—')}</td>
        <td>${esc(e.syllabus)}</td>
        <td style="color:var(--text-2);font-size:12px">${esc(e.component)}</td>
        <td><strong>${esc(e.entries || '—')}</strong></td> <td><span class="tag tag-room">${esc(e.room||'—')}</span></td>
        <td>${invig  ? `<span class="tag tag-invig">${esc(invig.name)}</span>`  : '<span style="color:var(--text-3)">—</span>'}</td>
        <td>${backup ? `<span class="tag tag-backup">${esc(backup.name)}</span>` : '<span style="color:var(--text-3)">—</span>'}</td>
        <td><span class="exam-status ${st.cls}">${st.label}</span></td>
        <td><button class="btn-icon" title="Send now" onclick="manualNotify('${e.id}')">📧</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
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
  S.set('invigilators', invigilators);
  renderInvigilators(); updateStats(); closeModal();
  showToast(editingId?'Invigilator updated ✓':'Invigilator added ✓','success');
}

function deleteInvigilator(id) {
  if (!confirm('Delete this invigilator?')) return;
  invigilators = invigilators.filter(i=>i.id!==id);
  S.set('invigilators', invigilators);
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
async function manualNotify(examId) {
  const exam = exams.find(e=>e.id===examId);
  if (!exam) return;
  if (!initEmailJS()) { showToast('Configure EmailJS in Settings first','error'); return; }
  const s = getSettings();
  if (!s.ejsServiceId || !s.ejsTemplateId) { showToast('EmailJS not fully configured','error'); return; }

  showToast('Sending…','');
  let sent = 0, failed = 0;

  for (const [raw, role, type] of [
    [exam.invigRaw,  'Main Invigilator',   'main'],
    [exam.backupRaw, 'Backup Invigilator', 'backup'],
  ]) {
    const person = resolveInvigilator(raw);
    if (!person) continue;
    try {
      await sendOneEmail(exam, person, role);
      if (type==='main')   exam.notifiedMain   = 'manual';
      if (type==='backup') exam.notifiedBackup = 'manual';
      sent++;
    } catch(e) {
      logEntry(exam, person.name, role, resolveEmail(person), false, e.text||e.message);
      failed++;
    }
    await sleep(400);
  }

  S.set('exams', exams);
  renderDashboard(); renderTimetable(); renderLog();
  showToast(failed===0 ? `${sent} email(s) sent ✓` : `${sent} sent, ${failed} failed`, sent>0?'success':'error');
}

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
      const p = resolveInvigilator(exam.invigRaw);
      if (p) toSend.push({ exam, person:p, role:'Main Invigilator', type:'main' });
    }
    if (!exam.notifiedBackup) {
      const p = resolveInvigilator(exam.backupRaw);
      if (p) toSend.push({ exam, person:p, role:'Backup Invigilator', type:'backup' });
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
  S.set('exams', exams);
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
  S.set('notifLog', notifLog);
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

function clearLog() {
  if (!confirm('Clear all logs?')) return;
  notifLog=[]; S.set('notifLog', notifLog); renderLog(); showToast('Log cleared');
}

/* ═══════════════════════════════════════════════════════════════
   SETTINGS
   ═══════════════════════════════════════════════════════════════ */
function loadSettingsUI() {
  const s = getSettings();
  setV('sheetsUrl',s.sheetsUrl); setV('sheetsGid',s.sheetsGid);
  setV('ejsPublicKey',s.ejsPublicKey); setV('ejsServiceId',s.ejsServiceId); setV('ejsTemplateId',s.ejsTemplateId);
  setV('notifyMinutes',s.notifyMinutes); setV('emailDomain',s.emailDomain); setV('timezone',s.timezone);
}
function saveSheetSettings()  { saveSettings({sheetsUrl:getV('sheetsUrl'),sheetsGid:getV('sheetsGid')}); showToast('Sheet settings saved ✓','success'); }
function saveEmailSettings()  { saveSettings({ejsPublicKey:getV('ejsPublicKey'),ejsServiceId:getV('ejsServiceId'),ejsTemplateId:getV('ejsTemplateId')}); showToast('Email settings saved ✓','success'); }
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
