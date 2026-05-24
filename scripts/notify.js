/**
 * REGENT EXAM NOTIFIER — scripts/notify.js
 * ─────────────────────────────────────────────────────────────────
 * Run by GitHub Actions at 19:00 Warsaw (daily).
 * Sends emails for TOMORROW's exams to ALL assigned invigilators.
 * Robust RFC-4180 CSV parser — handles quoted commas, dual "Exam Date" columns.
 * ─────────────────────────────────────────────────────────────────
 */
'use strict';
const https = require('https');
const fs    = require('fs');
const path  = require('path');

/* ── CONFIG ──────────────────────────────────────────────────── */
const CFG = {
  sheetsUrl:     process.env.SHEETS_URL       || '',
  ejsPublicKey:  process.env.EJS_PUBLIC_KEY   || '',
  ejsServiceId:  process.env.EJS_SERVICE_ID   || '',
  ejsTemplateId: process.env.EJS_TEMPLATE_ID  || '',
  emailDomain:   process.env.EMAIL_DOMAIN     || 'regent.edu.pl',
};

const SENT_LOG = path.join(__dirname, '..', 'data', 'sent-log.json');

/* ── INVIGILATORS ────────────────────────────────────────────── */
const INVIGILATORS = [
  { name:'Anna Martowicz',      aliases:['AM','Anna M','Anna Martowicz']                        },
  { name:'Mariusz Krajewski',   aliases:['Mariusz','Krajewski','Mariusz Krajewski']             },
  { name:'Anna Santos',         aliases:['Anna Santos','Santos']                                },
  { name:'Marta Szweda',        aliases:['Marta','Marta Szweda','Szweda']                       },
  { name:'Krzysztof Martowicz', aliases:['KM','Krzysztof','Krzysztof Martowicz','Martowicz']    },
  { name:'Maciej Pyrka',        aliases:['Maciek','Maciek/','Maciek//','Maciej','Maciej Pyrka'] },
  { name:'Anna Panfil',         aliases:['Panfil','Anna Panfil']                                },
  { name:'Roger Messer',        aliases:['Roger','Roger Messer','Messer']                       },
  { name:'Kristy Khemraj',      aliases:['Kristy','Kristy Khemraj','Kristy//','Khemraj']       },
  { name:'Justice Inkoom',      aliases:['Justice','Justice//','Justice Inkoom']                },
  { name:'Zipporah Bvalani',    aliases:['Zipporah','Zipporah//','Zipporah Bvalani']            },
  { name:'Szymon',              aliases:['Szymon','Szymon//']                                   },
];

/* ── WARSAW TIME ─────────────────────────────────────────────── */
function warsawTomorrowISO() {
  // Get today in Warsaw time using sv-SE locale (returns YYYY-MM-DD)
  const todayWarsaw = new Date().toLocaleDateString('sv-SE', { timeZone:'Europe/Warsaw' });
  // Add one day safely without any Date() timezone risk
  const [y, m, d] = todayWarsaw.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  const ty = dt.getUTCFullYear();
  const tm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const td = String(dt.getUTCDate()).padStart(2, '0');
  return `${ty}-${tm}-${td}`;
}

/* ── TIME HELPERS ────────────────────────────────────────────── */
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
function addMins(t, delta) {
  const b = parseTimeToMins(t);
  return b != null ? minsToTime(b + delta) : '';
}
function fmtDate(d) {
  try {
    return new Date(d+'T12:00:00Z').toLocaleDateString('en-GB',
      { weekday:'long', day:'numeric', month:'long', year:'numeric', timeZone:'UTC' });
  } catch { return d; }
}

/* ── SAFE DATE PARSER — no new Date() for date-only values ───── */
function parseDateSafe(raw) {
  const s = (raw || '').toString().trim();
  // "2026-05-21 00:00:00" or "2026-05-21T…" — take first 10 chars
  if (/^\d{4}-\d{2}-\d{2}[T \d]/.test(s)) return s.substring(0, 10);
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d,m,y] = s.split('/'); return `${y}-${m}-${d}`;
  }
  if (/^\d{2}\/\d{2}\/\d{2}$/.test(s)) {
    const [d,m,y] = s.split('/'); return `20${y}-${m}-${d}`;
  }
  if (/^\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4}$/.test(s)) {
    const months={jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
                  jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
    const p = s.split(/\s+/);
    const mon = months[p[1].toLowerCase().substring(0,3)] || '01';
    const yr  = p[2].length===2 ? '20'+p[2] : p[2];
    return `${yr}-${mon}-${p[0].padStart(2,'0')}`;
  }
  if (/^\d{5}$/.test(s)) {
    const serial = parseInt(s) - (parseInt(s) > 59 ? 1 : 0);
    const d = new Date(Date.UTC(1899,11,31) + serial*86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  return '';
}

/* ── MULTI-NAME SPLITTER ─────────────────────────────────────── */
function splitNames(raw) {
  if (!raw) return [];
  return raw.toString()
    .split(/[;,\n]+/)
    .map(s => s.replace(/\/+$/, '').trim())
    .filter(s => s && s !== '-' && s.toLowerCase() !== 'nan');
}

/* ── INVIGILATOR RESOLUTION ──────────────────────────────────── */
function generateEmail(name) {
  const clean = name.replace(/\s*\(.*?\)\s*/g, '').trim();
  const parts = clean.toLowerCase().replace(/[^a-z\s]/g,'').trim().split(/\s+/);
  return parts.length >= 2
    ? `${parts[0]}.${parts[parts.length-1]}@${CFG.emailDomain}`
    : `${parts[0]}@${CFG.emailDomain}`;
}

function resolveOne(rawName) {
  if (!rawName) return null;
  const cleaned = rawName.toString().replace(/\/+$/, '').trim();
  if (!cleaned || cleaned === '-' || cleaned.toLowerCase() === 'nan') return null;
  const found = INVIGILATORS.find(inv =>
    inv.aliases.some(a => a.toLowerCase() === cleaned.toLowerCase())
  );
  if (found) return { name: found.name, email: generateEmail(found.name) };
  const partial = INVIGILATORS.find(inv =>
    inv.name.split(' ')[0].toLowerCase() === cleaned.split(' ')[0].toLowerCase()
  );
  if (partial) return { name: partial.name, email: generateEmail(partial.name) };
  return { name: cleaned, email: generateEmail(cleaned) };
}

/** Resolve ALL names in a raw field, deduplicated by email */
function resolveAll(rawField) {
  return splitNames(rawField)
    .map(resolveOne)
    .filter(Boolean)
    .filter((p, i, arr) => arr.findIndex(q => q.email === p.email) === i);
}

/* ── ROBUST RFC-4180 CSV PARSER ──────────────────────────────── */
function csvRowToFields(line) {
  const fields = []; let inQ = false, cell = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i+1] === '"') { cell += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) { fields.push(cell); cell = ''; }
    else { cell += ch; }
  }
  fields.push(cell);
  return fields;
}

function parseTimetable(csv) {
  const rows = csv.split('\n').map(csvRowToFields);

  // Find header row
  let hi = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].map(c => (c||'').toLowerCase());
    if (r.some(c => c.includes('start time')) && r.some(c => c.includes('invigilator'))) {
      hi = i; break;
    }
  }
  if (hi === -1) throw new Error('Header row not found — check the correct sheet tab is published');

  const H   = rows[hi].map(c => (c||'').toLowerCase().trim());
  const col = kw => H.findIndex(h => h.includes(kw.toLowerCase()));

  // CRITICAL: "Exam Date" appears TWICE in this sheet.
  // col 5 = "Exam Date"  → date range text ("01 Mar - 30 Apr")
  // col 8 = "Exam Date " → actual exam datetime ("2026-05-22 00:00:00")
  // We need the SECOND occurrence.
  function colNth(kw, n) {
    let count = 0;
    for (let i = 0; i < H.length; i++) {
      if (H[i].includes(kw)) { count++; if (count === n) return i; }
    }
    return -1;
  }

  const C = {
    date:      colNth('exam date', 2), // 2nd occurrence = col 8 = actual datetime
    start:     col('start time'),
    finish:    col('finish time'),
    extMins:   col('ext. time in min'),
    extFinish: col('ext. finish time'),
    syllabus:  col('syllabus'),
    component: col('component title'),
    code:      col('code'),
    room:      col('room'),
    session:   col('session'),
    invig:     col('exam invigilator'),
    backup:    col('backup invigilator'),
    // Entries: first occurrence only (col 6), NOT col 26 (duplicate)
    entries:   H.findIndex((h, i) => h === 'entries' && i < 15),
  };

  console.log(`  Column map: date=${C.date} start=${C.start} invig=${C.invig} backup=${C.backup} entries=${C.entries}`);

  if (C.date < 0)  throw new Error(`"Exam Date" column (2nd occurrence) not found. Column map: ${JSON.stringify(C)}`);
  if (C.start < 0) throw new Error(`"Start time" column not found.`);

  const exams = [];
  let skipped = 0;

  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(c => !c || !c.trim())) continue;

    const rawDate  = C.date>=0     ? (r[C.date]    ||'').trim() : '';
    const rawStart = C.start>=0    ? (r[C.start]   ||'').trim() : '';
    const syllabus = C.syllabus>=0 ? (r[C.syllabus]||'').trim() : '';

    if (!syllabus || !rawDate || rawDate === 'NaN') { skipped++; continue; }

    const dateStr = parseDateSafe(rawDate);
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { skipped++; continue; }

    const startMins = parseTimeToMins(rawStart);
    if (startMins == null) { skipped++; continue; }

    const finishRaw    = C.finish>=0    ? (r[C.finish]   ||'').trim() : '';
    const extFinishRaw = C.extFinish>=0 ? (r[C.extFinish]||'').trim() : '';
    const extMinsRaw   = C.extMins>=0   ? (r[C.extMins]  ||'').trim() : '';
    const finishMins   = parseTimeToMins(finishRaw);
    let extFinishMins  = parseTimeToMins(extFinishRaw);
    if (extFinishMins==null && finishMins!=null && extMinsRaw && extMinsRaw!=='-') {
      const em = parseFloat(extMinsRaw);
      if (!isNaN(em) && em > 0) extFinishMins = finishMins + Math.round(em);
    }

    const rawEntries = C.entries>=0 ? (r[C.entries]||'').trim() : '';
    const entries    = rawEntries && rawEntries!=='nan' && rawEntries!=='-' ? rawEntries : '';
    const code       = C.code>=0 ? (r[C.code]||'').trim() : '';

    exams.push({
      id:           `exam_${dateStr}_${minsToTime(startMins)}_${(code||syllabus).replace(/\W/g,'_')}`,
      date:         dateStr,
      startTime:    minsToTime(startMins),
      finishTime:   finishMins    != null ? minsToTime(finishMins)    : '',
      extFinishTime:extFinishMins != null ? minsToTime(extFinishMins) : '',
      session:      C.session>=0  ? (r[C.session] ||'').trim() : '',
      room:         C.room>=0     ? (r[C.room]    ||'').trim() : '',
      syllabus, component: C.component>=0 ? (r[C.component]||'').trim() : '',
      code, entries,
      invigRaw:     C.invig>=0  ? (r[C.invig] ||'').trim() : '',
      backupRaw:    C.backup>=0 ? (r[C.backup]||'').trim() : '',
    });
  }

  console.log(`  Parsed: ${exams.length} exams, ${skipped} rows skipped`);
  return exams;
}

/* ── FETCH WITH RETRIES ──────────────────────────────────────── */
function fetchUrl(url, redirects=0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('Too many redirects'));
    https.get(url, { headers:{ 'User-Agent':'ExamNotifier/2.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, redirects+1).then(resolve).catch(reject);
      }
      if (res.statusCode === 401 || res.statusCode === 403) {
        return reject(new Error(
          `HTTP ${res.statusCode} — Sheet requires login.\n` +
          `FIX: Share sheet as "Anyone with link can view" then republish as CSV.`
        ));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (data.trimStart().startsWith('<')) {
          return reject(new Error('Google returned HTML (login page) instead of CSV. Make sheet public.'));
        }
        resolve(data);
      });
    }).on('error', e => reject(new Error(`Network: ${e.message}`)));
  });
}

async function fetchWithRetry(url, attempts=3) {
  for (let i=1; i<=attempts; i++) {
    try { return await fetchUrl(url); }
    catch(e) {
      if (i===attempts || e.message.includes('401') || e.message.includes('403') || e.message.includes('login')) throw e;
      console.log(`  Attempt ${i} failed: ${e.message.split('\n')[0]} — retrying in 5s…`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

/* ── EMAILJS REST ────────────────────────────────────────────── */
function sendEmailJS(params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      service_id:      CFG.ejsServiceId,
      template_id:     CFG.ejsTemplateId,
      user_id:         CFG.ejsPublicKey,
      template_params: params,
    });
    const req = https.request({
      hostname:'api.emailjs.com', path:'/api/v1.0/email/send', method:'POST',
      headers:{ 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) },
    }, res => {
      let data=''; res.on('data',c=>data+=c);
      res.on('end', ()=> res.statusCode===200 ? resolve() : reject(new Error(`EmailJS ${res.statusCode}: ${data}`)));
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

/* ── SENT LOG ────────────────────────────────────────────────── */
function loadSentLog() {
  try { if (fs.existsSync(SENT_LOG)) return JSON.parse(fs.readFileSync(SENT_LOG,'utf8')); }
  catch {}
  return {};
}
function saveSentLog(log) {
  fs.mkdirSync(path.dirname(SENT_LOG), { recursive:true });
  fs.writeFileSync(SENT_LOG, JSON.stringify(log, null, 2));
}

/* ── MAIN ────────────────────────────────────────────────────── */
async function main() {
  const now = new Date();
  console.log(`\n═══ Regent Exam Notifier · ${now.toISOString()} ═══`);
  console.log(`    Warsaw time: ${now.toLocaleTimeString('en-GB',{timeZone:'Europe/Warsaw',hour:'2-digit',minute:'2-digit'})}`);

  // Validate config
  const missing = ['sheetsUrl','ejsPublicKey','ejsServiceId','ejsTemplateId']
    .filter(k => !CFG[k]);
  if (missing.length) {
    console.error(`❌ Missing env vars: ${missing.map(k=>k.toUpperCase()).join(', ')}`);
    process.exit(1);
  }

  // Load sent log
  const sentLog = loadSentLog();

  // Determine target date (tomorrow in Warsaw)
  const targetDate = warsawTomorrowISO();
  console.log(`📅 Target date (tomorrow Warsaw): ${targetDate}`);

  // Fetch timetable
  console.log('📥 Fetching timetable…');
  let csv;
  try { csv = await fetchWithRetry(CFG.sheetsUrl); }
  catch(e) {
    e.message.split('\n').forEach(l => console.error('  ❌', l));
    process.exit(1);
  }

  // Parse
  let allExams;
  try { allExams = parseTimetable(csv); }
  catch(e) { console.error('❌ Parse error:', e.message); process.exit(1); }

  const targetExams = allExams.filter(e => e.date === targetDate);
  console.log(`🔍 Exams on ${targetDate}: ${targetExams.length} of ${allExams.length} total`);

  if (!targetExams.length) {
    console.log('✅ No exams tomorrow — nothing to send.');
    return;
  }

  // Build send list — ALL main + ALL backup invigilators per exam
  const toSend = [];
  for (const exam of targetExams) {
    const mainList   = resolveAll(exam.invigRaw);
    const backupList = resolveAll(exam.backupRaw);

    for (const person of mainList) {
      const key = `${exam.id}__main__${person.email}`;
      if (!sentLog[key]) toSend.push({ exam, person, role:'Main Invigilator', key });
      else console.log(`  ⏭ Already sent: ${person.email} (Main) for ${exam.syllabus}`);
    }
    for (const person of backupList) {
      const key = `${exam.id}__backup__${person.email}`;
      if (!sentLog[key]) toSend.push({ exam, person, role:'Backup Invigilator', key });
      else console.log(`  ⏭ Already sent: ${person.email} (Backup) for ${exam.syllabus}`);
    }
  }

  if (!toSend.length) {
    console.log('✅ All notifications already sent for tomorrow\'s exams.');
    saveSentLog(sentLog);
    return;
  }

  console.log(`\n📧 Sending ${toSend.length} notification(s)…`);
  let sent = 0, failed = 0;

  for (const { exam, person, role, key } of toSend) {
    const params = {
      to_name:        person.name.split(' ')[0],
      to_email:       person.email,
      exam_subject:   exam.syllabus,
      exam_component: exam.component || '',
      exam_date:      fmtDate(exam.date),
      exam_time:      exam.startTime,
      exam_room:      exam.room || 'TBC',
      finish_time:    exam.finishTime    || 'TBC',
      ext_finish:     exam.extFinishTime || 'N/A',
      num_entries:    exam.entries       || 'N/A',
      role,
      readiness_time: addMins(exam.startTime, -20),
    };

    try {
      await sendEmailJS(params);
      sentLog[key] = new Date().toISOString();
      console.log(`  ✓ ${person.email} — ${role} — ${exam.syllabus} @ ${exam.startTime}`);
      sent++;
    } catch(e) {
      console.error(`  ✗ ${person.email}: ${e.message}`);
      failed++;
    }
    await new Promise(r => setTimeout(r, 500)); // rate-limit buffer
  }

  // Prune log entries older than 90 days
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
  let pruned = 0;
  for (const k of Object.keys(sentLog)) {
    if (typeof sentLog[k] === 'string' && new Date(sentLog[k]) < cutoff) {
      delete sentLog[k]; pruned++;
    }
  }
  if (pruned) console.log(`🧹 Pruned ${pruned} old log entries`);

  saveSentLog(sentLog);

  console.log(`\n📊 Summary: ${sent} sent · ${failed} failed · ${Object.keys(sentLog).length} in log`);
  console.log('═══ Done ═══\n');

  if (failed > 0 && sent === 0) process.exit(1);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
