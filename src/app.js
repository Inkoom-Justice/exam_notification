/* ═══════════════════════════════════════════════════════════════
   REGENT EXAM NOTIFIER — src/app.js  (ES Module)
   Firebase persistence · multi-invigilator · compile/PDF · archive
   Warsaw timezone throughout · robust CSV parsing
   ═══════════════════════════════════════════════════════════════ */
import { db, auth, ensureAuth, Settings, Invigilators,
         Timetable, NotifLog } from './firebase-service.js';

'use strict';

/* ─── LOCAL FALLBACK (while Firebase loads) ───────────────────── */
const L = {
  get(k)    { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ─── DEFAULTS ─────────────────────────────────────────────────── */
const DEFAULT_SETTINGS = {
  sheetsUrl:'', ejsPublicKey:'', ejsServiceId:'', ejsTemplateId:'',
  notifyMinutes:60, emailDomain:'regent.edu.pl',
  pin:'1234', autoNotifyEnabled:true,
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
let exams        = [];
let invigilators = [];
let notifLog     = [];
let settings     = { ...DEFAULT_SETTINGS };
let editingId    = null;
let compileInvigId = null;
let currentArchiveId = null;
let autoInterval = null;
let fbReady      = false;

/* ═══════════════════════════════════════════════════════════════
   WARSAW TIME
   ═══════════════════════════════════════════════════════════════ */
const warsawTodayISO = () =>
  new Date().toLocaleDateString('sv-SE', { timeZone:'Europe/Warsaw' });

const warsawNowMinutes = () => {
  const t = new Date().toLocaleTimeString('en-GB',
    { timeZone:'Europe/Warsaw', hour:'2-digit', minute:'2-digit' });
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

function parseTimeToMins(raw) {
  if (!raw) return null;
  const s = raw.toString().trim();
  if (/^\d+\.\d+$/.test(s)) return Math.round(parseFloat(s) * 24 * 60);
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : null;
}
function minsToTime(mins) {
  if (mins == null || isNaN(mins)) return '';
  return `${String(Math.floor(mins/60)%24).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`;
}
function addMins(t, d) {
  const b = parseTimeToMins(t); return b != null ? minsToTime(b + d) : '';
}

/* ── Safe date extraction — no new Date() for date-only values ── */
function parseDateSafe(raw) {
  const s = (raw || '').toString().trim();
  // "2026-05-21 00:00:00" or "2026-05-21T…" — take first 10 chars directly
  if (/^\d{4}-\d{2}-\d{2}[T \d]/.test(s)) return s.substring(0, 10);
  // "DD/MM/YYYY"
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d,m,y] = s.split('/'); return `${y}-${m}-${d}`;
  }
  // "DD/MM/YY"
  if (/^\d{2}\/\d{2}\/\d{2}$/.test(s)) {
    const [d,m,y] = s.split('/'); return `20${y}-${m}-${d}`;
  }
  // "21 May 26"
  if (/^\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4}$/.test(s)) {
    const months={jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
                  jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
    const p = s.split(/\s+/);
    const mon = months[p[1].toLowerCase().substring(0,3)] || '01';
    const yr  = p[2].length===2 ? '20'+p[2] : p[2];
    return `${yr}-${mon}-${p[0].padStart(2,'0')}`;
  }
  // Excel serial "45802"
  if (/^\d{5}$/.test(s)) {
    const serial = parseInt(s) - (parseInt(s) > 59 ? 1 : 0);
    const d = new Date(Date.UTC(1899,11,31) + serial*86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  return '';
}

/* ═══════════════════════════════════════════════════════════════
   MULTI-INVIGILATOR NAME SPLITTER
   Handles: "Anna M; Roger Messer; Marta Szweda" or commas or newlines
   ═══════════════════════════════════════════════════════════════ */
function splitNames(raw) {
  if (!raw) return [];
  return raw
    .split(/[;,\n]+/)
    .map(s => s.replace(/\/+$/, '').trim())
    .filter(s => s && s !== '-' && s.toLowerCase() !== 'nan');
}

/* ═══════════════════════════════════════════════════════════════
   INVIGILATOR RESOLUTION
   ═══════════════════════════════════════════════════════════════ */
function generateEmail(name) {
  const domain = settings.emailDomain || 'regent.edu.pl';
  const clean  = name.replace(/\s*\(.*?\)\s*/g,'').trim();
  const parts  = clean.toLowerCase().replace(/[^a-z\s]/g,'').trim().split(/\s+/);
  return parts.length>=2
    ? `${parts[0]}.${parts[parts.length-1]}@${domain}`
    : `${parts[0]}@${domain}`;
}
function resolveEmail(inv) {
  return (inv?.email?.trim()) || generateEmail(inv?.name || 'unknown');
}
function resolveOne(rawName) {
  if (!rawName?.trim()) return null;
  const cleaned = rawName.toString().replace(/\/+$/,'').trim();
  if (!cleaned || cleaned==='-' || cleaned.toLowerCase()==='nan') return null;
  const found = invigilators.find(inv =>
    inv.active && inv.aliases.some(a=>a.trim().toLowerCase()===cleaned.toLowerCase())
  );
  if (found) return found;
  const partial = invigilators.find(inv =>
    inv.active && inv.name.split(' ')[0].toLowerCase()===cleaned.split(' ')[0].toLowerCase()
  );
  return partial || { id:null, name:cleaned, email:'', aliases:[], active:true };
}

/** Resolve ALL names in a raw field (semicolon/comma separated) */
function resolveAll(rawField) {
  return splitNames(rawField)
    .map(n => resolveOne(n))
    .filter(Boolean)
    .filter((p, i, arr) =>
      // Deduplicate by resolved email
      arr.findIndex(q => resolveEmail(q) === resolveEmail(p)) === i
    );
}

/* ═══════════════════════════════════════════════════════════════
   EXAM STATUS
   ═══════════════════════════════════════════════════════════════ */
function examStatus(exam) {
  const today   = warsawTodayISO();
  const nowMins = warsawNowMinutes();
  const start   = parseTimeToMins(exam.startTime);
  const finish  = parseTimeToMins(exam.finishTime);
  const ext     = parseTimeToMins(exam.extFinishTime);

  if (exam.date < today) return { cls:'status-past',    label:'⚫ Past' };
  if (exam.date > today) {
    const days = Math.round((new Date(exam.date)-new Date(today))/86400000);
    return { cls:'status-future', label: days===1?'Tomorrow':`In ${days}d` };
  }
  if (ext    !=null && nowMins>=start && nowMins<ext)    return { cls:'status-extended', label:`🔵 Extended · ends ${minsToTime(ext)}` };
  if (finish !=null && nowMins>=start && nowMins<finish)  return { cls:'status-ongoing',  label:`🟢 Ongoing · ends ${minsToTime(finish)}` };
  const end = ext||finish;
  if (end!=null && nowMins>=end)  return { cls:'status-past', label:'⚫ Past' };
  if (finish==null && nowMins>start+30) return { cls:'status-past', label:'⚫ Past' };
  if (exam.notifiedMain)          return { cls:'status-notified', label:'✓ Notified' };
  const mins = start - nowMins;
  if (mins>=0 && mins<=settings.notifyMinutes)
    return { cls:'status-window', label:`⏰ Notify in ${mins}m` };
  const h=Math.floor(mins/60), m=mins%60;
  return { cls:'status-future', label: h>0?`In ${h}h ${m}m`:`In ${m}m` };
}

/* ═══════════════════════════════════════════════════════════════
   AUTH / INIT
   ═══════════════════════════════════════════════════════════════ */
function login() {
  const pinInput = document.getElementById('pinInput');
  const errEl    = document.getElementById('loginErr');
  const pin      = (pinInput.value||'').trim();
  errEl.textContent = '';
  if (!pin) { errEl.textContent='Please enter your PIN.'; return; }
  if (pin === String(settings.pin||'1234')) {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    pinInput.value = '';
    initApp();
  } else {
    errEl.textContent='Incorrect PIN — try again.';
    pinInput.value=''; pinInput.focus();
  }
}
function logout() {
  clearInterval(autoInterval);
  document.getElementById('app').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
  const p=document.getElementById('pinInput');
  if(p){p.value='';p.focus();}
}

document.addEventListener('DOMContentLoaded', async () => {
  // Wire up login
  document.getElementById('loginBtn').addEventListener('click', login);
  document.getElementById('pinInput').addEventListener('keydown', e=>{ if(e.key==='Enter') login(); });
  document.getElementById('pinInput').focus();

  // Connect to Firebase
  try {
    setFbStatus('Connecting…','');
    await ensureAuth();
    fbReady = true;
    setFbStatus('● Firebase','ok');
    document.getElementById('fbStatus').textContent = '✅ Database connected';

    // Load settings + PIN before showing login
    const remote = await Settings.get();
    if (remote && Object.keys(remote).length) {
      settings = Object.assign({}, DEFAULT_SETTINGS, remote);
    }
  } catch(e) {
    console.warn('Firebase unavailable, using local storage:', e.message);
    setFbStatus('⚠ Offline','err');
    document.getElementById('fbStatus').textContent = '⚠️ Database offline — using local storage';
    settings = Object.assign({}, DEFAULT_SETTINGS, L.get('settings')||{});
    fbReady = false;
  }
});

async function initApp() {
  loadSettingsUI();

  // Load invigilators
  if (fbReady) {
    try {
      const remote = await Invigilators.getAll();
      invigilators = remote.length ? remote : DEFAULT_INVIGILATORS;
      // If empty, seed defaults to Firebase
      if (!remote.length) await Invigilators.saveAll(DEFAULT_INVIGILATORS);
    } catch { invigilators = L.get('invigilators') || DEFAULT_INVIGILATORS; }
  } else {
    invigilators = L.get('invigilators') || DEFAULT_INVIGILATORS;
  }

  // Load active timetable from Firebase
  if (fbReady) {
    try {
      const active = await Timetable.getActive();
      if (active?.exams?.length) {
        // Merge notification flags
        const flags = await Timetable.getAllFlags().catch(()=>({}));
        exams = active.exams.map(e => ({
          ...e,
          notifiedMain:   flags[e.id]?.notifiedMain   || e.notifiedMain   || false,
          notifiedBackup: flags[e.id]?.notifiedBackup || e.notifiedBackup || false,
        }));
      } else {
        exams = L.get('exams') || [];
      }
      // Load log
      notifLog = await NotifLog.getRecent(300).catch(()=>[]);
    } catch { exams = L.get('exams')||[]; notifLog = L.get('notifLog')||[]; }
  } else {
    exams = L.get('exams')||[];
    notifLog = L.get('notifLog')||[];
  }

  renderInvigilators();
  renderDashboard();
  renderTimetable();
  renderLog();
  updateStats();
  updateFbStatusPanel();

  // Auto-engine
  runAutoCheck();
  autoInterval = setInterval(()=>{ runAutoCheck(); renderDashboard(); renderTimetable(); updateStats(); }, 60000);
}

function switchTab(name, el) {
  document.querySelectorAll('.tab-section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('tab-'+name)?.classList.add('active');
  el?.classList.add('active');
  if (name==='archive') loadArchiveList();
  if (name==='log') renderLog();
}

/* ═══════════════════════════════════════════════════════════════
   CSV PARSING — robust RFC-4180 parser
   ═══════════════════════════════════════════════════════════════ */
function csvRowToFields(line) {
  const fields=[]; let inQ=false, cell='';
  for (let i=0;i<line.length;i++) {
    const ch=line[i];
    if (ch==='"') {
      if (inQ && line[i+1]==='"') { cell+='"'; i++; }
      else inQ=!inQ;
    } else if (ch===','&&!inQ) { fields.push(cell); cell=''; }
    else { cell+=ch; }
  }
  fields.push(cell);
  return fields;
}

function parseTimetableCSV(csv) {
  const lines = csv.split('\n');
  const rows  = lines.map(csvRowToFields);

  // Find header row
  let hi=-1;
  for (let i=0;i<rows.length;i++) {
    const r=rows[i].map(c=>(c||'').toLowerCase());
    if (r.some(c=>c.includes('start time')) && r.some(c=>c.includes('invigilator'))) { hi=i; break; }
  }
  if (hi===-1) {
    showBanner('❌ Header row not found. Check the correct sheet tab is published.','err');
    return 0;
  }

  // Map columns — CRITICAL: "Exam Date" appears twice.
  // col 5 = "Exam Date" (date range text), col 8 = "Exam Date " (actual datetime)
  // We find the SECOND occurrence of "exam date" for col 8.
  const H = rows[hi].map(c=>(c||'').toLowerCase().trim());

  function colNth(kw, n) {
    let count=0;
    for (let i=0;i<H.length;i++) {
      if (H[i].includes(kw)) { count++; if(count===n) return i; }
    }
    return -1;
  }
  const col = kw => H.findIndex(h=>h.includes(kw.toLowerCase()));

  const C = {
    date:      colNth('exam date', 2), // 2nd occurrence = col 8 = actual datetime
    start:     col('start time'),
    finish:    col('finish time'),
    extMins:   col('ext. time in min'),
    extFinish: col('ext. finish time'),
    extFor:    col('extended time for'),
    room:      col('room'),
    session:   col('session'),
    syllabus:  col('syllabus'),
    component: col('component title'),
    code:      col('code'),
    invig:     col('exam invigilator'),
    backup:    col('backup invigilator'),
    comments:  col('comments'),
    // Entries: col 6 (first occurrence, NOT col 26 which is a duplicate)
    entries:   H.findIndex((h,i)=>h==='entries' && i<15),
  };

  // Diagnostic log
  console.info('[Sync] Column map:', C);
  if (C.date<0)  { showBanner('❌ Cannot find "Exam Date" column (2nd occurrence). Check sheet tab.','err'); return 0; }
  if (C.start<0) { showBanner('❌ Cannot find "Start time" column.','err'); return 0; }

  const existing = new Map(exams.map(e=>[e.id,e]));
  const parsed=[]; let skipped=0;

  for (let i=hi+1;i<rows.length;i++) {
    const r=rows[i];
    if (!r||r.every(c=>!c||!c.trim())) continue;

    const rawDate  = C.date>=0     ? (r[C.date]    ||'').trim() : '';
    const rawStart = C.start>=0    ? (r[C.start]   ||'').trim() : '';
    const syllabus = C.syllabus>=0 ? (r[C.syllabus]||'').trim() : '';

    if (!syllabus||!rawDate||rawDate==='NaN') { skipped++; continue; }

    const dateStr = parseDateSafe(rawDate);
    if (!dateStr||!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { skipped++; continue; }

    const startMins = parseTimeToMins(rawStart);
    if (startMins==null) { skipped++; continue; }

    const finishRaw    = C.finish>=0    ? (r[C.finish]   ||'').trim() : '';
    const extFinishRaw = C.extFinish>=0 ? (r[C.extFinish]||'').trim() : '';
    const extMinsRaw   = C.extMins>=0   ? (r[C.extMins]  ||'').trim() : '';
    const finishMins   = parseTimeToMins(finishRaw);
    let extFinishMins  = parseTimeToMins(extFinishRaw);
    if (extFinishMins==null&&finishMins!=null&&extMinsRaw&&extMinsRaw!=='-') {
      const em=parseFloat(extMinsRaw);
      if (!isNaN(em)&&em>0) extFinishMins=finishMins+Math.round(em);
    }

    const rawEntries = C.entries>=0 ? (r[C.entries]||'').trim() : '';
    const entries    = rawEntries&&rawEntries!=='nan'&&rawEntries!=='-' ? rawEntries : '';
    const code       = C.code>=0 ? (r[C.code]||'').trim() : '';
    const id         = `exam_${dateStr}_${minsToTime(startMins)}_${(code||syllabus).replace(/\W/g,'_')}`;
    const prev       = existing.get(id);

    parsed.push({
      id, date:dateStr,
      startTime:    minsToTime(startMins),
      finishTime:   finishMins    !=null ? minsToTime(finishMins)    : '',
      extFinishTime:extFinishMins !=null ? minsToTime(extFinishMins) : '',
      room:      C.room>=0     ? (r[C.room]    ||'').trim() : '',
      session:   C.session>=0  ? (r[C.session] ||'').trim() : '',
      syllabus, component: C.component>=0 ? (r[C.component]||'').trim() : '',
      code, entries,
      extFor:    C.extFor>=0   ? (r[C.extFor]  ||'').trim() : '',
      invigRaw:  C.invig>=0    ? (r[C.invig]   ||'').trim() : '',
      backupRaw: C.backup>=0   ? (r[C.backup]  ||'').trim() : '',
      comments:  C.comments>=0 ? (r[C.comments]||'').trim() : '',
      notifiedMain:   prev?.notifiedMain   || false,
      notifiedBackup: prev?.notifiedBackup || false,
    });
  }

  if (!parsed.length) {
    showBanner(`❌ 0 exams parsed. ${skipped} rows skipped. Column map: date=${C.date} start=${C.start} syllabus=${C.syllabus}. Check GID points to correct sheet tab.`,'err');
    return 0;
  }

  exams = parsed;
  // Save to Firebase + local
  if (fbReady) {
    Timetable.saveActive(exams).catch(console.error);
  }
  L.set('exams', exams);
  renderDashboard(); renderTimetable(); updateStats();

  const today = warsawTodayISO();
  showBanner(`✅ ${parsed.length} exams loaded · ${exams.filter(e=>e.date===today).length} today · ${skipped} rows skipped`,'ok');
  showToast(`${parsed.length} exams loaded ✓`,'success');
  return parsed.length;
}

/* ═══════════════════════════════════════════════════════════════
   CORS PROXY FETCH
   ═══════════════════════════════════════════════════════════════ */
const PROXIES=[
  u=>`https://corsproxy.io/?${encodeURIComponent(u)}`,
  u=>`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  u=>`https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
  u=>`https://thingproxy.freeboard.io/fetch/${u}`,
];
const PROXY_NAMES=['corsproxy.io','codetabs.com','allorigins.win','thingproxy'];

async function proxyFetch(csvUrl, onProg) {
  let lastErr='Unknown';
  for (let i=0;i<PROXIES.length;i++) {
    if (onProg) onProg(`Trying proxy ${i+1}/4: ${PROXY_NAMES[i]}…`);
    try {
      const ctrl=new AbortController();
      const t=setTimeout(()=>ctrl.abort(),10000);
      const res=await fetch(PROXIES[i](csvUrl),{signal:ctrl.signal});
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text=await res.text();
      try { const j=JSON.parse(text); if(j?.contents) return {csv:j.contents,proxy:PROXY_NAMES[i]}; } catch {}
      if (text.includes(',')&&text.split('\n').length>2) return {csv:text,proxy:PROXY_NAMES[i]};
      throw new Error('Not CSV');
    } catch(e) { lastErr=e.name==='AbortError'?'Timed out':e.message; }
  }
  throw new Error(`All proxies failed. Last: ${lastErr}`);
}

async function fetchTimetable() {
  const url=settings.sheetsUrl;
  showBanner('⏳ Connecting…','info');
  if (!url) { showBanner('❌ No sheet URL. Go to Settings → Google Sheets.','err'); return; }
  try {
    const {csv,proxy}=await proxyFetch(url,msg=>showBanner(`⏳ ${msg}`,'info'));
    parseTimetableCSV(csv);
  } catch(e) { showBanner(`❌ ${e.message}`,'err'); }
}

async function testSheetConnection() {
  const url=document.getElementById('sheetsUrl').value.trim();
  const el=document.getElementById('connResult');
  if (!url) { showResult(el,'⚠️ Paste your CSV URL first.','err'); return; }
  showResult(el,'⏳ Testing…','info');
  try {
    const {csv,proxy}=await proxyFetch(url,msg=>showResult(el,`⏳ ${msg}`,'info'));
    showResult(el,`✅ Connected via ${proxy}! ${csv.split('\n').filter(r=>r.trim()).length} rows received. Click Sync Now.`,'ok');
  } catch(e) {
    showResult(el,`❌ ${e.message}\n\nEnsure: sheet published as CSV, URL is correct, sheet is public.`,'err');
  }
}

/* ═══════════════════════════════════════════════════════════════
   TIMETABLE SAVE / ARCHIVE
   ═══════════════════════════════════════════════════════════════ */
async function saveTimetablePrompt() {
  if (!exams.length) { showToast('No timetable to save — sync first','error'); return; }
  const label=prompt(`Save this timetable with a label:\n(e.g. "June 2026 Exams")`,
    `${new Date().toLocaleDateString('en-GB',{month:'long',year:'numeric'})} Exams`);
  if (!label) return;
  try {
    if (fbReady) {
      await Timetable.archiveCurrent(label);
      showToast('Timetable archived ✓','success');
    } else {
      const archives=L.get('archives')||[];
      archives.unshift({ id:'arch_'+Date.now(), label, examCount:exams.length,
        archivedAt:new Date().toISOString(), exams:[...exams] });
      L.set('archives',archives);
      showToast('Timetable archived (local) ✓','success');
    }
  } catch(e) { showToast('Archive failed: '+e.message,'error'); }
}

async function loadArchiveList() {
  const el=document.getElementById('archiveContainer');
  el.innerHTML='<p class="empty-state">Loading…</p>';
  let archives=[];
  try {
    if (fbReady) { archives=await Timetable.getArchives(); }
    else { archives=(L.get('archives')||[]).map(a=>({...a,archivedAt:new Date(a.archivedAt)})); }
  } catch(e) { el.innerHTML=`<p class="empty-state">Error: ${esc(e.message)}</p>`; return; }

  if (!archives.length) { el.innerHTML='<p class="empty-state">No saved timetables yet. Use "💾 Save Timetable" to archive the current one.</p>'; return; }

  el.innerHTML=archives.map(a=>`
    <div class="archive-row">
      <div>
        <strong>${esc(a.label)}</strong>
        <div class="archive-meta">${a.examCount} exams · saved ${fmtTs(a.archivedAt)}</div>
      </div>
      <button class="btn-ghost" style="font-size:12px" onclick="viewArchive('${a.id}')">👁 View</button>
      <button class="btn-ghost" style="font-size:12px" onclick="restoreArchive('${a.id}')">↩ Restore</button>
      <button class="btn-danger" onclick="deleteArchive('${a.id}',this)">🗑</button>
    </div>`).join('');
}

async function viewArchive(id) {
  let archives=[];
  if (fbReady) archives=await Timetable.getArchives().catch(()=>[]);
  else archives=L.get('archives')||[];

  const a=archives.find(x=>x.id===id);
  if (!a) return;

  currentArchiveId=id;
  document.getElementById('archiveViewTitle').textContent=a.label;
  document.getElementById('archiveViewContent').innerHTML=
    renderExamTable(a.exams||[]);
  document.getElementById('restoreArchiveBtn').onclick=()=>restoreArchive(id);
  document.getElementById('archiveViewModal').classList.remove('hidden');
}

async function restoreArchive(id) {
  if (!confirm('Restore this archived timetable as the active timetable?')) return;
  let archives=[];
  if (fbReady) archives=await Timetable.getArchives().catch(()=>[]);
  else archives=L.get('archives')||[];

  const a=archives.find(x=>x.id===id);
  if (!a||!a.exams) { showToast('Archive not found','error'); return; }

  exams=[...a.exams];
  if (fbReady) await Timetable.saveActive(exams,a.label).catch(console.error);
  L.set('exams',exams);
  renderDashboard(); renderTimetable(); updateStats();
  document.getElementById('archiveViewModal').classList.add('hidden');
  showToast('Timetable restored ✓','success');
}

async function deleteArchive(id, btn) {
  if (!confirm('Permanently delete this archived timetable?')) return;
  try {
    if (fbReady) await Timetable.deleteArchive(id);
    else {
      const a=L.get('archives')||[];
      L.set('archives',a.filter(x=>x.id!==id));
    }
    btn.closest('.archive-row').remove();
    showToast('Deleted');
  } catch(e) { showToast('Delete failed: '+e.message,'error'); }
}

/* ═══════════════════════════════════════════════════════════════
   COMPILE — invigilator schedule + PDF
   ═══════════════════════════════════════════════════════════════ */
function compileInvigilator(invId) {
  const inv=invigilators.find(i=>i.id===invId);
  if (!inv) return;
  compileInvigId=invId;

  // Find all exams where this invigilator is main or backup
  const myExams=exams.filter(e=>{
    const mainNames=splitNames(e.invigRaw);
    const backNames=splitNames(e.backupRaw);
    const allAliases=inv.aliases.map(a=>a.toLowerCase());
    const matches=name=>allAliases.some(a=>a===name.replace(/\/+$/,'').toLowerCase())
      ||inv.name.split(' ')[0].toLowerCase()===name.split(' ')[0].toLowerCase();
    return mainNames.some(matches)||backNames.some(matches);
  }).sort((a,b)=>a.date.localeCompare(b.date)||a.startTime.localeCompare(b.startTime));

  document.getElementById('compileTitle').textContent=
    `${inv.name} — Invigilation Schedule (${myExams.length} assignments)`;

  if (!myExams.length) {
    document.getElementById('compileContent').innerHTML=
      '<p class="empty-state">No invigilation assignments found for this invigilator in the current timetable.</p>';
  } else {
    document.getElementById('compileContent').innerHTML=`
      <div style="padding:0 4px 16px;font-size:13px;color:var(--text-2)">
        Email: <strong>${resolveEmail(inv)}</strong> · ${myExams.length} assignment(s)
      </div>
      <div style="overflow-x:auto">
      <table class="compile-table">
        <thead><tr>
          <th>Date</th><th>Day</th><th>Subject</th><th>Component</th>
          <th>Code</th><th>Venue</th><th>Start</th><th>Finish</th>
          <th>Ext. End</th><th>Students</th><th>Role</th>
        </tr></thead>
        <tbody>${myExams.map(e=>{
          const mainNames=splitNames(e.invigRaw).map(n=>n.toLowerCase());
          const alias=inv.aliases.map(a=>a.toLowerCase());
          const isMain=mainNames.some(n=>alias.some(a=>a===n)||inv.name.split(' ')[0].toLowerCase()===n.split(' ')[0].toLowerCase());
          const role=isMain?'Main':'Backup';
          const d=new Date(e.date+'T12:00:00Z');
          const day=d.toLocaleDateString('en-GB',{weekday:'long',timeZone:'UTC'});
          return `<tr>
            <td>${fmtDate(e.date)}</td><td>${day}</td>
            <td>${esc(e.syllabus)}</td><td>${esc(e.component)}</td>
            <td>${esc(e.code)}</td><td>${esc(e.room)}</td>
            <td>${e.startTime}</td><td>${e.finishTime||'—'}</td>
            <td>${e.extFinishTime||'—'}</td><td>${e.entries||'—'}</td>
            <td><strong>${role}</strong></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`;
  }
  document.getElementById('compileModal').classList.remove('hidden');
}

function closeCompileModal() {
  document.getElementById('compileModal').classList.add('hidden');
  compileInvigId=null;
}

async function generateAndSendPDF() {
  const inv=invigilators.find(i=>i.id===compileInvigId);
  if (!inv) return;

  const myExams=exams.filter(e=>{
    const allAliases=inv.aliases.map(a=>a.toLowerCase());
    const matches=name=>allAliases.some(a=>a===name.replace(/\/+$/,'').toLowerCase())
      ||inv.name.split(' ')[0].toLowerCase()===name.split(' ')[0].toLowerCase();
    return splitNames(e.invigRaw).some(matches)||splitNames(e.backupRaw).some(matches);
  }).sort((a,b)=>a.date.localeCompare(b.date)||a.startTime.localeCompare(b.startTime));

  if (!myExams.length) { showToast('No assignments to generate PDF for','error'); return; }

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation:'landscape', unit:'mm', format:'a4' });

    // Header
    doc.setFontSize(16);
    doc.setFont('helvetica','bold');
    doc.text('REGENT EXAM NOTIFIER', 14, 18);
    doc.setFontSize(12);
    doc.setFont('helvetica','normal');
    doc.text(`Invigilation Schedule: ${inv.name}`, 14, 26);
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text(`Generated: ${new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}`, 14, 32);
    doc.text(`Email: ${resolveEmail(inv)}  ·  Assignments: ${myExams.length}`, 14, 37);
    doc.setTextColor(0);

    // Table
    doc.autoTable({
      startY: 42,
      head: [['Date','Day','Subject','Component','Code','Room','Start','Finish','Ext. End','Students','Role']],
      body: myExams.map(e=>{
        const allAliases=inv.aliases.map(a=>a.toLowerCase());
        const matches=name=>allAliases.some(a=>a===name.replace(/\/+$/,'').toLowerCase())
          ||inv.name.split(' ')[0].toLowerCase()===name.split(' ')[0].toLowerCase();
        const isMain=splitNames(e.invigRaw).some(matches);
        const d=new Date(e.date+'T12:00:00Z');
        return [
          fmtDate(e.date),
          d.toLocaleDateString('en-GB',{weekday:'short',timeZone:'UTC'}),
          e.syllabus, e.component||'', e.code||'', e.room||'',
          e.startTime, e.finishTime||'—', e.extFinishTime||'—',
          e.entries||'—', isMain?'Main':'Backup'
        ];
      }),
      styles:{ fontSize:8, cellPadding:2 },
      headStyles:{ fillColor:[26,26,46], fontSize:8 },
      alternateRowStyles:{ fillColor:[247,246,242] },
      columnStyles:{ 2:{cellWidth:35}, 3:{cellWidth:30} },
    });

    // Footer
    const pages=doc.internal.getNumberOfPages();
    for (let p=1;p<=pages;p++) {
      doc.setPage(p);
      doc.setFontSize(7);
      doc.setTextColor(150);
      doc.text(`Regent Exam Notifier · ${inv.name} · Page ${p} of ${pages}`,
        doc.internal.pageSize.width/2, doc.internal.pageSize.height-6, {align:'center'});
    }

    // Save locally
    doc.save(`${inv.name.replace(/\s+/g,'_')}_Invigilation_Schedule.pdf`);

    // Email via EmailJS
    const s=settings;
    if (s.ejsPublicKey&&s.ejsServiceId&&s.ejsTemplateId) {
      if (!initEmailJS()) { showToast('EmailJS not configured','error'); return; }
      const pdfBase64 = doc.output('datauristring');
      await emailjs.send(s.ejsServiceId, s.ejsTemplateId, {
        to_name:        inv.name.split(' ')[0],
        to_email:       resolveEmail(inv),
        exam_subject:   'Your Complete Invigilation Schedule',
        exam_component: `${myExams.length} assignments`,
        exam_date:      'See attached PDF',
        exam_time:      '—',
        exam_room:      '—',
        finish_time:    '—',
        ext_finish:     '—',
        num_entries:    '—',
        role:           'See attached PDF',
        readiness_time: '—',
      });
      showToast('PDF downloaded & email sent ✓','success');
    } else {
      showToast('PDF downloaded (configure EmailJS to also send by email)','success');
    }
  } catch(e) {
    console.error(e);
    showToast('PDF error: '+e.message,'error');
  }
}

/* ═══════════════════════════════════════════════════════════════
   DASHBOARD
   ═══════════════════════════════════════════════════════════════ */
function renderDashboard() {
  const today=warsawTodayISO();
  const lim=new Date(); lim.setDate(lim.getDate()+2);
  const limStr=lim.toLocaleDateString('sv-SE',{timeZone:'Europe/Warsaw'});
  renderExamCards('todayExams',   exams.filter(e=>e.date===today),              true);
  renderExamCards('upcomingExams',exams.filter(e=>e.date>today&&e.date<=limStr),false);
}

function renderExamCards(id, list, showBtn) {
  const el=document.getElementById(id); if(!el) return;
  if(!list.length){el.innerHTML='<p class="empty-state">Nothing here.</p>';return;}
  el.innerHTML=list.map(exam=>{
    const st=examStatus(exam);
    const invigs=resolveAll(exam.invigRaw);
    const backups=resolveAll(exam.backupRaw);
    return `
    <div class="exam-card">
      <div class="exam-time-badge">${exam.startTime}<span class="session-tag">${exam.session||'—'}</span></div>
      <div class="exam-info">
        <div class="exam-subject">${esc(exam.syllabus)}</div>
        <div class="exam-component">${esc(exam.component)}</div>
        <div class="exam-meta">
          ${exam.room    ?`<span class="tag tag-room">📍 ${esc(exam.room)}</span>`:''}
          ${invigs.map(p=>`<span class="tag tag-invig">👤 ${esc(p.name)}</span>`).join('')}
          ${backups.map(p=>`<span class="tag tag-backup">🔁 ${esc(p.name)}</span>`).join('')}
          ${exam.entries ?`<span class="tag tag-entries">👥 ${esc(exam.entries)} students</span>`:''}
          ${exam.finishTime?`<span class="tag tag-time">ends ${exam.finishTime}${exam.extFinishTime?' · ext '+exam.extFinishTime:''}</span>`:''}
        </div>
      </div>
      <div class="exam-actions">
        <span class="exam-status ${st.cls}">${st.label}</span>
        ${showBtn?`<button class="btn-icon" title="Send now" onclick="manualNotify('${exam.id}')">📧</button>`:''}
      </div>
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════════
   TIMETABLE TABLE
   ═══════════════════════════════════════════════════════════════ */
function renderExamTable(list) {
  if (!list.length) return '<p class="empty-state">No exams.</p>';
  return `<table class="data-table">
    <thead><tr><th>Date</th><th>Start</th><th>Finish</th><th>Ext</th>
    <th>Subject</th><th>Component</th><th>Room</th><th>Students</th>
    <th>Main Invigilator(s)</th><th>Backup(s)</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map(e=>{
      const st=examStatus(e);
      const invigs=resolveAll(e.invigRaw);
      const backups=resolveAll(e.backupRaw);
      return `<tr>
        <td><strong>${fmtDate(e.date)}</strong></td>
        <td>${e.startTime}</td><td>${e.finishTime||'—'}</td>
        <td>${e.extFinishTime?`<span class="tag tag-ext">${e.extFinishTime}</span>`:'—'}</td>
        <td>${esc(e.syllabus)}</td>
        <td style="font-size:12px;color:var(--text-2)">${esc(e.component)}</td>
        <td><span class="tag tag-room">${esc(e.room||'—')}</span></td>
        <td>${e.entries?`<span class="tag tag-entries">${esc(e.entries)}</span>`:'—'}</td>
        <td>${invigs.length?invigs.map(p=>`<span class="tag tag-invig">${esc(p.name)}</span>`).join(' '):'<span style="color:var(--text-3)">—</span>'}</td>
        <td>${backups.length?backups.map(p=>`<span class="tag tag-backup">${esc(p.name)}</span>`).join(' '):'<span style="color:var(--text-3)">—</span>'}</td>
        <td><span class="exam-status ${st.cls}">${st.label}</span></td>
        <td><button class="btn-icon" onclick="manualNotify('${e.id}')">📧</button></td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

function renderTimetable() {
  const el=document.getElementById('timetableContainer'); if(!el) return;
  const q=(document.getElementById('searchExams')?.value||'').toLowerCase();
  const list=q
    ?exams.filter(e=>[e.syllabus,e.component,e.date,e.room,e.invigRaw,e.backupRaw,e.entries]
        .some(v=>(v||'').toLowerCase().includes(q)))
    :exams;
  el.innerHTML=list.length?renderExamTable(list):'<p class="empty-state">No exams found.</p>';
}

/* ═══════════════════════════════════════════════════════════════
   INVIGILATORS
   ═══════════════════════════════════════════════════════════════ */
function renderInvigilators() {
  const tbody=document.getElementById('invigilatorBody'); if(!tbody) return;
  tbody.innerHTML=invigilators.map(inv=>`
    <tr>
      <td><strong>${esc(inv.name)}</strong></td>
      <td style="font-size:12px;color:var(--text-2)">${esc(resolveEmail(inv))}</td>
      <td style="font-size:12px;color:var(--text-3)">${esc(inv.aliases.join(', '))}</td>
      <td><span class="${inv.active?'badge-active':'badge-inactive'}">${inv.active?'● Active':'○ Inactive'}</span></td>
      <td>
        <button class="btn-icon" title="Compile schedule" onclick="compileInvigilator('${inv.id}')">📋</button>
        <button class="btn-icon" onclick="openEditModal('${inv.id}')">✏️</button>
        <button class="btn-danger" onclick="deleteInvigilator('${inv.id}')">🗑</button>
      </td>
    </tr>`).join('');
}

function openAddModal() {
  editingId=null;
  ['mName','mEmail','mAliases'].forEach(id=>{document.getElementById(id).value='';});
  document.getElementById('mActive').value='true';
  document.getElementById('modalTitle').textContent='Add Invigilator';
  document.getElementById('invigModal').classList.remove('hidden');
  document.getElementById('mName').focus();
}
function openEditModal(id) {
  const inv=invigilators.find(i=>i.id===id); if(!inv) return;
  editingId=id;
  document.getElementById('modalTitle').textContent='Edit Invigilator';
  document.getElementById('mName').value=inv.name;
  document.getElementById('mEmail').value=inv.email||'';
  document.getElementById('mAliases').value=inv.aliases.join(', ');
  document.getElementById('mActive').value=inv.active?'true':'false';
  document.getElementById('invigModal').classList.remove('hidden');
}
function closeModal(){document.getElementById('invigModal').classList.add('hidden');editingId=null;}

async function saveInvigilator() {
  const name=document.getElementById('mName').value.trim();
  if(!name){showToast('Name is required','error');return;}
  const email  =document.getElementById('mEmail').value.trim();
  const aliases=document.getElementById('mAliases').value.split(',').map(a=>a.trim()).filter(Boolean);
  const active =document.getElementById('mActive').value==='true';
  let inv;
  if (editingId) {
    inv={...invigilators.find(i=>i.id===editingId), name, email, aliases, active};
    invigilators=invigilators.map(i=>i.id===editingId?inv:i);
  } else {
    inv={id:'inv_'+Date.now(), name, email, aliases, active};
    invigilators.push(inv);
  }
  if (fbReady) await Invigilators.save(inv).catch(console.error);
  L.set('invigilators',invigilators);
  renderInvigilators(); updateStats(); closeModal();
  showToast(editingId?'Updated ✓':'Added ✓','success');
}

async function deleteInvigilator(id) {
  if(!confirm('Delete this invigilator?')) return;
  invigilators=invigilators.filter(i=>i.id!==id);
  if (fbReady) await Invigilators.delete(id).catch(console.error);
  L.set('invigilators',invigilators);
  renderInvigilators(); updateStats(); showToast('Deleted');
}

/* ═══════════════════════════════════════════════════════════════
   EMAILJS
   ═══════════════════════════════════════════════════════════════ */
function initEmailJS() {
  if (!settings.ejsPublicKey) return false;
  try { emailjs.init(settings.ejsPublicKey); return true; } catch { return false; }
}

async function sendOneEmail(exam, person, role) {
  const params={
    to_name:        person.name.split(' ')[0],
    to_email:       resolveEmail(person),
    exam_subject:   exam.syllabus,
    exam_component: exam.component||'',
    exam_date:      fmtDate(exam.date),
    exam_time:      exam.startTime,
    exam_room:      exam.room||'TBC',
    finish_time:    exam.finishTime||'TBC',
    ext_finish:     exam.extFinishTime||'N/A',
    num_entries:    exam.entries||'N/A',
    role,
    readiness_time: addMins(exam.startTime,-20),
  };
  await emailjs.send(settings.ejsServiceId, settings.ejsTemplateId, params);
  await addLog({
    examDate:exam.date, examTime:exam.startTime, subject:exam.syllabus,
    entries:exam.entries||'', name:person.name, role, email:resolveEmail(person),
    success:true, error:null,
  });
}

async function addLog(entry) {
  notifLog.unshift({...entry, ts:new Date().toISOString()});
  if (notifLog.length>500) notifLog=notifLog.slice(0,500);
  L.set('notifLog',notifLog);
  if (fbReady) await NotifLog.add(entry).catch(()=>{});
}

/* ── Manual send (📧 button) — sends to ALL invigilators ───────── */
async function manualNotify(examId) {
  const exam=exams.find(e=>e.id===examId); if(!exam) return;
  if(!initEmailJS()){showToast('Configure EmailJS in Settings first','error');return;}

  showToast('Sending…','');
  let sent=0, failed=0;

  // Resolve ALL main and ALL backup invigilators
  const pairs=[
    ...resolveAll(exam.invigRaw).map(p=>[p,'Main Invigilator','main']),
    ...resolveAll(exam.backupRaw).map(p=>[p,'Backup Invigilator','backup']),
  ];

  for (const [person,role,type] of pairs) {
    try {
      await sendOneEmail(exam,person,role);
      if(type==='main')   exam.notifiedMain=true;
      if(type==='backup') exam.notifiedBackup=true;
      sent++;
    } catch(e) {
      await addLog({examDate:exam.date,examTime:exam.startTime,subject:exam.syllabus,
        entries:exam.entries||'',name:person.name,role,email:resolveEmail(person),
        success:false,error:e.text||e.message});
      failed++;
    }
    await sleep(400);
  }

  if (fbReady) {
    if (exam.notifiedMain)   await Timetable.markNotified(exam.id,'main').catch(()=>{});
    if (exam.notifiedBackup) await Timetable.markNotified(exam.id,'backup').catch(()=>{});
  }
  L.set('exams',exams);
  renderDashboard(); renderTimetable(); renderLog(); updateStats();
  showToast(failed===0?`${sent} email(s) sent ✓`:`${sent} sent, ${failed} failed`, sent>0?'success':'error');
}

/* ── Auto engine — runs every 60s ─────────────────────────────── */
async function runAutoCheck() {
  if (!settings.autoNotifyEnabled) return;
  if (!initEmailJS()) return;

  const today=warsawTodayISO(), nowMins=warsawNowMinutes();
  const win=settings.notifyMinutes||60;
  const toSend=[];

  for (const exam of exams) {
    if (exam.date!==today) continue;
    const startMins=parseTimeToMins(exam.startTime); if(startMins==null) continue;
    const minsUntil=startMins-nowMins;
    if (minsUntil<win-2||minsUntil>win+2) continue;

    if (!exam.notifiedMain) {
      resolveAll(exam.invigRaw).forEach(p=>toSend.push({exam,person:p,role:'Main Invigilator',type:'main'}));
    }
    if (!exam.notifiedBackup) {
      resolveAll(exam.backupRaw).forEach(p=>toSend.push({exam,person:p,role:'Backup Invigilator',type:'backup'}));
    }
  }

  for (const {exam,person,role,type} of toSend) {
    try {
      await sendOneEmail(exam,person,role);
      const idx=exams.findIndex(e=>e.id===exam.id);
      if(idx!==-1){
        if(type==='main')   exams[idx].notifiedMain=true;
        if(type==='backup') exams[idx].notifiedBackup=true;
        if(fbReady) Timetable.markNotified(exam.id,type).catch(()=>{});
      }
    } catch(e) {
      await addLog({examDate:exam.date,examTime:exam.startTime,subject:exam.syllabus,
        entries:exam.entries||'',name:person.name,role,email:resolveEmail(person),
        success:false,error:e.text||e.message});
    }
    await sleep(400);
  }
  if (toSend.length) {
    L.set('exams',exams);
    renderLog(); updateStats();
    showToast(`Auto-sent ${toSend.length} notification(s) ✓`,'success');
  }
}

/* ── Manual check from settings panel ─────────────────────────── */
async function runNotificationCheck() {
  const el=document.getElementById('checkResult');
  if(!initEmailJS()){showResult(el,'❌ EmailJS not configured.','err');return;}
  showResult(el,'⏳ Scanning…','info');
  const today=warsawTodayISO(), nowMins=warsawNowMinutes();
  const win=settings.notifyMinutes||60;
  const toSend=[];

  for (const exam of exams) {
    if (exam.date!==today) continue;
    const startMins=parseTimeToMins(exam.startTime); if(startMins==null) continue;
    const minsUntil=startMins-nowMins;
    if (minsUntil<win-8||minsUntil>win+8) continue;
    if (!exam.notifiedMain)   resolveAll(exam.invigRaw).forEach(p=>toSend.push({exam,person:p,role:'Main Invigilator',type:'main'}));
    if (!exam.notifiedBackup) resolveAll(exam.backupRaw).forEach(p=>toSend.push({exam,person:p,role:'Backup Invigilator',type:'backup'}));
  }

  if (!toSend.length) {
    showResult(el,`✅ Nothing due now. ${exams.length} exams · ${today} · ${minsToTime(nowMins)} Warsaw\nSystem auto-fires ${win} min before each exam.`,'ok');
    return;
  }

  let sent=0,failed=0;
  for (const {exam,person,role,type} of toSend) {
    try {
      await sendOneEmail(exam,person,role);
      const idx=exams.findIndex(e=>e.id===exam.id);
      if(idx!==-1){
        if(type==='main')   exams[idx].notifiedMain=true;
        if(type==='backup') exams[idx].notifiedBackup=true;
        if(fbReady) Timetable.markNotified(exam.id,type).catch(()=>{});
      }
      sent++;
    } catch(e) {
      await addLog({examDate:exam.date,examTime:exam.startTime,subject:exam.syllabus,
        entries:exam.entries||'',name:person.name,role,email:resolveEmail(person),
        success:false,error:e.text||e.message});
      failed++;
    }
    await sleep(400);
  }
  L.set('exams',exams);
  renderDashboard(); renderTimetable(); renderLog(); updateStats();
  showResult(el,`✅ Sent ${sent} · Failed ${failed}`, failed>0?'err':'ok');
}

async function sendTestEmail() {
  const el=document.getElementById('emailTestResult');
  if(!initEmailJS()){showResult(el,'❌ Fill in EmailJS settings and Save first.','err');return;}
  showResult(el,'⏳ Sending…','info');
  try {
    await emailjs.send(settings.ejsServiceId,settings.ejsTemplateId,{
      to_name:'Test User',to_email:'test@example.com',
      exam_subject:'TEST — Mathematics',exam_component:'Pure Mathematics 1',
      exam_date:fmtDate(warsawTodayISO()),exam_time:'10:00',
      exam_room:'5D',finish_time:'12:15',ext_finish:'12:49',
      num_entries:'28',role:'Main Invigilator',readiness_time:'09:40',
    });
    showResult(el,'✅ Test email sent!','ok');
  } catch(e){showResult(el,`❌ ${e.text||e.message}`,'err');}
}

/* ═══════════════════════════════════════════════════════════════
   LOG
   ═══════════════════════════════════════════════════════════════ */
function renderLog() {
  const el=document.getElementById('logContainer'); if(!el) return;
  if(!notifLog.length){el.innerHTML='<p class="empty-state">No notifications yet.</p>';return;}
  el.innerHTML=notifLog.map(e=>`
    <div class="log-entry">
      <div class="log-time">${fmtTs(e.ts)}</div>
      <div>
        <strong>${esc(e.name)}</strong> · ${esc(e.role)}<br/>
        <span style="color:var(--text-2);font-size:12px">
          ${esc(e.subject)} · ${fmtDate(e.examDate)} ${e.examTime||''}
          ${e.entries?`· 👥 ${esc(e.entries)} students`:''}
          · ${esc(e.email||'')}
        </span>
        ${e.error?`<br/><span style="color:var(--accent);font-size:11px">⚠ ${esc(e.error)}</span>`:''}
      </div>
      <div class="${e.success?'log-ok':'log-fail'}">${e.success?'✓ Sent':'✗ Failed'}</div>
    </div>`).join('');
}

async function clearLog() {
  if(!confirm('Clear all notification logs?')) return;
  notifLog=[]; L.set('notifLog',[]);
  renderLog(); showToast('Log cleared');
}

/* ═══════════════════════════════════════════════════════════════
   SETTINGS
   ═══════════════════════════════════════════════════════════════ */
function loadSettingsUI() {
  setV('sheetsUrl',settings.sheetsUrl);
  setV('ejsPublicKey',settings.ejsPublicKey);
  setV('ejsServiceId',settings.ejsServiceId);
  setV('ejsTemplateId',settings.ejsTemplateId);
  setV('notifyMinutes',settings.notifyMinutes||60);
  setV('emailDomain',settings.emailDomain||'regent.edu.pl');
  const tog=document.getElementById('autoNotifyToggle');
  if(tog) tog.checked=settings.autoNotifyEnabled!==false;
}

async function _saveSettings(patch) {
  settings=Object.assign(settings,patch);
  L.set('settings',settings);
  if (fbReady) await Settings.save(settings).catch(console.error);
}

async function saveSheetSettings(){
  await _saveSettings({sheetsUrl:getV('sheetsUrl')});
  showToast('Sheet settings saved ✓','success');
}
async function saveEmailSettings(){
  await _saveSettings({ejsPublicKey:getV('ejsPublicKey'),ejsServiceId:getV('ejsServiceId'),ejsTemplateId:getV('ejsTemplateId')});
  showToast('Email settings saved ✓','success');
}
async function saveNotifSettings(){
  const tog=document.getElementById('autoNotifyToggle');
  await _saveSettings({
    notifyMinutes:parseInt(getV('notifyMinutes'))||60,
    emailDomain:getV('emailDomain'),
    autoNotifyEnabled:tog?tog.checked:true,
  });
  renderInvigilators();
  showToast('Rules saved ✓','success');
}

async function changePin(){
  const el=document.getElementById('pinResult');
  const current=document.getElementById('currentPin').value;
  const newPin =document.getElementById('newPin').value;
  const confirm=document.getElementById('confirmPin').value;
  if(current!==String(settings.pin)){showResult(el,'❌ Current PIN incorrect.','err');return;}
  if(newPin.length<4){showResult(el,'❌ PIN must be 4+ digits.','err');return;}
  if(!/^\d+$/.test(newPin)){showResult(el,'❌ Digits only.','err');return;}
  if(newPin!==confirm){showResult(el,'❌ PINs do not match.','err');return;}
  await _saveSettings({pin:newPin});
  ['currentPin','newPin','confirmPin'].forEach(id=>{document.getElementById(id).value='';});
  showResult(el,'✅ PIN changed.','ok');
}

/* ═══════════════════════════════════════════════════════════════
   STATS + UI HELPERS
   ═══════════════════════════════════════════════════════════════ */
function updateStats() {
  const today=warsawTodayISO();
  setTxt('statToday',    exams.filter(e=>e.date===today).length);
  setTxt('statSentToday',notifLog.filter(l=>l.success&&(l.ts||'').startsWith(today)).length);
  setTxt('statInvig',    invigilators.filter(i=>i.active).length);
  setTxt('statTotal',    exams.length);
}

function updateFbStatusPanel() {
  const el=document.getElementById('fbStatusPanel');
  if(!el) return;
  showResult(el, fbReady
    ? '✅ Firebase connected — all data persists across devices automatically.'
    : '⚠️ Firebase offline — using local browser storage. Data may not sync across devices.', fbReady?'ok':'err');
}

function setFbStatus(text,cls) {
  const el=document.getElementById('dbDot'); if(!el) return;
  el.textContent=text; el.className='db-dot'+(cls?' '+cls:'');
}

function showBanner(msg,type){
  const el=document.getElementById('syncBanner'); if(!el) return;
  el.innerHTML=msg.replace(/\n/g,'<br/>');
  el.className=`sync-banner show ${type}`;
}
function showResult(el,msg,type){
  if(!el) return;
  el.innerHTML=msg.replace(/\n/g,'<br/>');
  el.className=`result-box show ${type}`;
}
let _tt;
function showToast(msg,type=''){
  const t=document.getElementById('toast'); if(!t) return;
  t.textContent=msg; t.className=`toast ${type}`; t.classList.remove('hidden');
  clearTimeout(_tt); _tt=setTimeout(()=>t.classList.add('hidden'),3400);
}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmtDate(d){
  try{return new Date(d+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});}catch{return d;}
}
function fmtTs(ts){
  try{
    const d=ts?.toDate?ts.toDate():new Date(ts);
    return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'Europe/Warsaw'})
      +' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Warsaw'});
  }catch{return String(ts||'');}
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function getV(id){return(document.getElementById(id)?.value||'').trim();}
function setV(id,v){const el=document.getElementById(id);if(el)el.value=v??'';}
function setTxt(id,v){const el=document.getElementById(id);if(el)el.textContent=v;}

/* ── Expose globals needed by onclick= handlers ─────────────────── */
window.login=login; window.logout=logout; window.switchTab=switchTab;
window.fetchTimetable=fetchTimetable; window.testSheetConnection=testSheetConnection;
window.saveTimetablePrompt=saveTimetablePrompt; window.loadArchiveList=loadArchiveList;
window.viewArchive=viewArchive; window.restoreArchive=restoreArchive; window.deleteArchive=deleteArchive;
window.openAddModal=openAddModal; window.openEditModal=openEditModal; window.closeModal=closeModal;
window.saveInvigilator=saveInvigilator; window.deleteInvigilator=deleteInvigilator;
window.compileInvigilator=compileInvigilator; window.closeCompileModal=closeCompileModal;
window.generateAndSendPDF=generateAndSendPDF;
window.manualNotify=manualNotify; window.runNotificationCheck=runNotificationCheck;
window.sendTestEmail=sendTestEmail; window.clearLog=clearLog;
window.saveSheetSettings=saveSheetSettings; window.saveEmailSettings=saveEmailSettings;
window.saveNotifSettings=saveNotifSettings; window.changePin=changePin;
window.renderTimetable=renderTimetable;
