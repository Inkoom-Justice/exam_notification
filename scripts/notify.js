/**
 * REGENT EXAM NOTIFIER — notify.js (GitHub Actions)
 * ─────────────────────────────────────────────────────────────────
 * Runs every 15 min via cron. Uses Warsaw time throughout.
 * Sends EmailJS notifications 60 min (configurable) before each exam.
 * Duplicate-send protection via data/sent-log.json committed to repo.
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
  notifyMinutes: parseInt(process.env.NOTIFY_MINUTES || '60'),
  emailDomain:   process.env.EMAIL_DOMAIN     || 'regent.edu.pl',
};

const SENT_LOG = path.join(__dirname, '..', 'data', 'sent-log.json');

/* ── INVIGILATORS (mirrors admin UI defaults) ────────────────── */
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
  { name:'Szymon Paczkowski',   aliases:['Szymon','Szymon//']                                   },
];

/* ── HELPERS ─────────────────────────────────────────────────── */

/** Current date in Warsaw as "YYYY-MM-DD" */
function warsawTodayISO() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
}

/** Current Warsaw time as total minutes since midnight */
function warsawNowMinutes() {
  const t = new Date().toLocaleTimeString('en-GB', {
    timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit'
  });
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** "HH:MM:SS" or Excel fraction → minutes since midnight */
function parseTimeToMins(raw) {
  if (!raw) return null;
  const s = raw.toString().trim();
  if (/^\d+\.\d+$/.test(s)) return Math.round(parseFloat(s) * 24 * 60);
  const match = s.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return parseInt(match[1]) * 60 + parseInt(match[2]);
}

function minsToTime(mins) {
  if (mins == null || isNaN(mins)) return '';
  return `${String(Math.floor(mins/60)%24).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`;
}

function addMins(timeStr, delta) {
  const base = parseTimeToMins(timeStr);
  return base != null ? minsToTime(base + delta) : '';
}

function generateEmail(name) {
  const clean = name.replace(/\s*\(.*?\)\s*/g, '').trim();
  const parts = clean.toLowerCase().replace(/[^a-z\s]/g,'').trim().split(/\s+/);
  return parts.length >= 2
    ? `${parts[0]}.${parts[parts.length-1]}@${CFG.emailDomain}`
    : `${parts[0]}@${CFG.emailDomain}`;
}

function resolveInvigilator(raw) {
  if (!raw) return null;
  const cleaned = raw.toString().replace(/\/+$/, '').trim();
  if (!cleaned || cleaned === '-' || cleaned.toLowerCase() === 'nan') return null;
  // Exact alias match
  const found = INVIGILATORS.find(inv =>
    inv.aliases.some(a => a.toLowerCase() === cleaned.toLowerCase())
  );
  if (found) return { name: found.name, email: generateEmail(found.name) };
  // First-name partial match
  const partial = INVIGILATORS.find(inv =>
    inv.name.split(' ')[0].toLowerCase() === cleaned.split(' ')[0].toLowerCase()
  );
  if (partial) return { name: partial.name, email: generateEmail(partial.name) };
  // Fallback: use raw value
  return { name: cleaned, email: generateEmail(cleaned) };
}

function fmtDate(dateStr) {
  try {
    return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-GB', {
      weekday:'long', day:'numeric', month:'long', year:'numeric', timeZone:'UTC'
    });
  } catch { return dateStr; }
}


function parseDateFlexible(raw) {
  if (!raw) return null;
  const s = raw.toString().trim();

  // ISO or timestamp-like
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);

  // DD/MM/YYYY or DD/MM/YY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/');
    return `${y}-${m}-${d}`;
  }
  if (/^\d{2}\/\d{2}\/\d{2}$/.test(s)) {
    const [d, m, y] = s.split('/');
    return `20${y}-${m}-${d}`;
  }

  // DD MMM YYYY (e.g. 17 Apr 2026)
  if (/^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}$/.test(s)) {
    const [d, mon, y] = s.split(/\s+/);
    const months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
                    jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
    return `${y}-${months[mon.toLowerCase().substring(0,3)]}-${d.padStart(2,'0')}`;
  }

  // Weekday DD Month YYYY (e.g. Friday 17 April 2026)
  if (/^[A-Za-z]+\s+\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(s)) {
    const parts = s.split(/\s+/);
    const months = {january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',
                    july:'07',august:'08',september:'09',october:'10',november:'11',december:'12'};
    const mon = months[parts[2].toLowerCase()] || '01';
    return `${parts[3]}-${mon}-${parts[1].padStart(2,'0')}`;
  }

  // Excel serial number
  if (/^\d{5}$/.test(s)) {
    const serial = parseInt(s) - (parseInt(s) > 59 ? 1 : 0);
    const ms = new Date(Date.UTC(1899,11,31)).getTime() + serial * 86400000;
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }

  return null;
}


/* ── FETCH WITH REDIRECT FOLLOW + CLEAR ERROR MESSAGES ─────── */
function fetchUrl(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('Too many redirects (>10). Check the URL.'));

    https.get(url, { headers: { 'User-Agent': 'ExamNotifier/1.0' } }, res => {
      // Follow redirects (Google Sheets /pub URLs redirect several times)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`  ↳ Redirect ${redirects + 1}: ${res.headers.location.substring(0, 80)}…`);
        return fetchUrl(res.headers.location, redirects + 1).then(resolve).catch(reject);
      }

      if (res.statusCode === 401 || res.statusCode === 403) {
        return reject(new Error(
          `HTTP ${res.statusCode} — Google is blocking anonymous access to the sheet.\n` +
          `  FIX: Open the sheet → Share → set to "Anyone with the link can view"\n` +
          `  Then: File → Share → Publish to web → select tab → CSV → Publish\n` +
          `  Use the /pub?gid=...&output=csv URL (not /export or /edit URLs)`
        ));
      }

      if (res.statusCode === 404) {
        return reject(new Error(
          `HTTP 404 — Sheet not found. Check the SHEETS_URL secret is correct.`
        ));
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} — Unexpected response from Google Sheets.`));
      }

      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        // Sanity check: if we got HTML instead of CSV, Google is showing a login page
        if (data.trimStart().startsWith('<!DOCTYPE') || data.trimStart().startsWith('<html')) {
          return reject(new Error(
            `Google returned an HTML page instead of CSV.\n` +
            `  This means the sheet requires a login to view.\n` +
            `  FIX: Share the sheet as "Anyone with the link can view", then re-publish as CSV.`
          ));
        }
        resolve(data);
      });
    }).on('error', err => reject(new Error(`Network error: ${err.message}`)));
  });
}

/* ── FETCH WITH RETRY (3 attempts, 5s apart) ────────────────── */
async function fetchWithRetry(url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      console.log(`  Attempt ${i}/${attempts}…`);
      return await fetchUrl(url);
    } catch (err) {
      if (i === attempts) throw err;
      // Don't retry auth errors — they won't resolve by retrying
      if (err.message.includes('401') || err.message.includes('403') ||
          err.message.includes('login page')) throw err;
      console.warn(`  Attempt ${i} failed: ${err.message.split('\n')[0]} — retrying in 5s…`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

/* ── CSV PARSER — proper RFC-4180, handles quoted commas ─────── */
function csvRowToFields(line) {
  const fields = [];
  let inQ = false, cell = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i+1] === '"') { cell += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      fields.push(cell); cell = '';
    } else { cell += ch; }
  }
  fields.push(cell);
  return fields;
}

function csvToRows(csv) {
  return csv.split('\n').map(line => csvRowToFields(line));
}

function parseTimetable(csv) {
  const rows = csvToRows(csv);
  let hi = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].map(c => (c||'').toLowerCase());
    if (r.some(c => c.includes('start time')) && r.some(c => c.includes('invigilator'))) {
      hi = i; break;
    }
  }
  if (hi === -1) throw new Error('Header row not found — sheet may not be the correct tab');

  // IMPORTANT: col 5 = "Exam Date" (date range), col 8 = "Exam Date " (actual datetime)
  // We must find the SECOND occurrence of "exam date" to get col 8
  const H = rows[hi].map(c => (c||'').toLowerCase().trim());
  const col = kw => H.findIndex(h => h.includes(kw.toLowerCase()));

  function colNth(kw, n) {
    let count = 0;
    for (let i = 0; i < H.length; i++) {
      if (H[i].includes(kw)) { count++; if (count === n) return i; }
    }
    return -1;
  }

  const C = {
    date:      col('exam date'),
    start:     col('start time'),
    finish:    col('finish time'),
    extMins:   col('ext. time in min'),
    extFinish: col('ext. finish time'),
    syllabus:  col('syllabus'),
    component: col('component title'),
    code:      col('code'),
    room:      col('room'),
    invig:     col('exam invigilator'),
    backup:    col('backup invigilator'),
    entries:   col('entries'),
  };

  // Prefer the first "entries" occurrence (col 6), not the duplicate near end
  if (C.entries === -1) {
    C.entries = H.findIndex(h => h === 'entries');
  }

  console.log(`  Column map: date=${C.date} start=${C.start} finish=${C.finish} invig=${C.invig} backup=${C.backup} entries=${C.entries}`);

  const exams = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(c => !c)) continue;

    const rawDate   = (r[C.date]     || '').toString().trim();
    const rawStart  = (r[C.start]    || '').toString().trim();
    const syllabus  = (r[C.syllabus] || '').toString().trim();
    if (!rawDate || !rawStart || !syllabus || rawDate === 'NaN') continue;

    // ── DATE PARSING ─────────────────────────────────────────────────
    // Google Sheets CSV exports dates as "2026-05-21 00:00:00" (space separator).
    // Passing this to new Date() causes UTC midnight → local-time off-by-one in UTC+2.
    // We extract YYYY-MM-DD directly from the string — zero timezone risk.
    const dateStr = parseDateFlexible(rawDate);
    if (!dateStr) continue;

    const startMins = parseTimeToMins(rawStart);
    if (startMins == null) continue;

    // Finish & extended finish
    const finishRaw    = C.finish    >= 0 ? (r[C.finish]    || '').toString().trim() : '';
    const extFinishRaw = C.extFinish >= 0 ? (r[C.extFinish] || '').toString().trim() : '';
    const extMinsRaw   = C.extMins   >= 0 ? (r[C.extMins]   || '').toString().trim() : '';

    const finishMins    = parseTimeToMins(finishRaw);
    let   extFinishMins = parseTimeToMins(extFinishRaw);
    if (extFinishMins == null && finishMins != null && extMinsRaw && extMinsRaw !== '-') {
      const em = parseFloat(extMinsRaw);
      if (!isNaN(em) && em > 0) extFinishMins = finishMins + Math.round(em);
    }

    const code    = C.code >= 0 ? (r[C.code] || '').toString().trim() : '';
    const id      = `exam_${dateStr}_${minsToTime(startMins)}_${(code||syllabus).replace(/\W/g,'_')}`;

    const rawEntries = C.entries >= 0 ? (r[C.entries] || '').toString().trim() : '';
    const entries    = rawEntries && rawEntries !== 'nan' && rawEntries !== '-' ? rawEntries : '';

    exams.push({
      id, date: dateStr,
      startTime:    minsToTime(startMins),
      finishTime:   finishMins    != null ? minsToTime(finishMins)    : '',
      extFinishTime:extFinishMins != null ? minsToTime(extFinishMins) : '',
      syllabus,
      component: C.component >= 0 ? (r[C.component] || '').toString().trim() : '',
      room:      C.room      >= 0 ? (r[C.room]      || '').toString().trim() : '',
      code, entries,
      invigRaw:  C.invig  >= 0 ? (r[C.invig]  || '').toString().trim() : '',
      backupRaw: C.backup >= 0 ? (r[C.backup] || '').toString().trim() : '',
    });
  }
  return exams;
}

/* ── SENT LOG ────────────────────────────────────────────────── */
function loadSentLog() {
  try {
    if (fs.existsSync(SENT_LOG)) return JSON.parse(fs.readFileSync(SENT_LOG, 'utf8'));
  } catch {}
  return {};
}

function saveSentLog(log) {
  const dir = path.dirname(SENT_LOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SENT_LOG, JSON.stringify(log, null, 2));
}

/* ── EMAILJS REST SEND ───────────────────────────────────────── */
function sendEmailJS(params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      service_id:      CFG.ejsServiceId,
      template_id:     CFG.ejsTemplateId,
      user_id:         CFG.ejsPublicKey,
      template_params: params,
    });
    const req = https.request({
      hostname: 'api.emailjs.com',
      path:     '/api/v1.0/email/send',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`EmailJS ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

/* ── MAIN ────────────────────────────────────────────────────── */
async function main() {
  console.log(`\n═══ Exam Notifier · ${new Date().toISOString()} ═══`);
  console.log(`    Warsaw time: ${new Date().toLocaleTimeString('en-GB',{timeZone:'Europe/Warsaw',hour:'2-digit',minute:'2-digit'})} · Today: ${warsawTodayISO()}`);

  // Validate config
  if (!CFG.sheetsUrl)     { console.error('❌ SHEETS_URL not set');      process.exit(1); }
  if (!CFG.ejsPublicKey)  { console.error('❌ EJS_PUBLIC_KEY not set');  process.exit(1); }
  if (!CFG.ejsServiceId)  { console.error('❌ EJS_SERVICE_ID not set');  process.exit(1); }
  if (!CFG.ejsTemplateId) { console.error('❌ EJS_TEMPLATE_ID not set'); process.exit(1); }

  // 1. Fetch sheet
  console.log('📥 Fetching timetable…');
  let csv;
  try { csv = await fetchWithRetry(CFG.sheetsUrl); }
  catch (e) {
    console.error('❌ Fetch failed:');
    // Print each line of the error for multi-line messages
    e.message.split('\n').forEach(l => console.error('  ' + l));
    process.exit(1);
  }

  // 2. Parse
  let exams;
  try { exams = parseTimetable(csv); }
  catch (e) { console.error('❌ Parse failed:', e.message); process.exit(1); }
  console.log(`📋 ${exams.length} exams parsed`);

  // 3. Find due notifications (Warsaw time window)
  const today    = warsawTodayISO();
  const nowMins  = warsawNowMinutes();
  const sentLog  = loadSentLog();
  const toSend   = [];

  for (const exam of exams) {
    if (exam.date !== today) continue; // Only today matters for 1-hr-before logic
    const startMins = parseTimeToMins(exam.startTime);
    if (startMins == null) continue;

    const minsUntil = startMins - nowMins;
    // Window: notifyMinutes ± 8 min to cover the 15-min cron gap
    const lo = CFG.notifyMinutes - 8;
    const hi = CFG.notifyMinutes + 8;
    if (minsUntil < lo || minsUntil > hi) continue;

    const invig  = resolveInvigilator(exam.invigRaw);
    const backup = resolveInvigilator(exam.backupRaw);
    const mkKey  = (id, role) => `${id}__${role}`;

    if (invig  && !sentLog[mkKey(exam.id, 'main')])
      toSend.push({ exam, person: invig,  role: 'Main Invigilator',   key: mkKey(exam.id,'main')   });
    if (backup && !sentLog[mkKey(exam.id, 'backup')])
      toSend.push({ exam, person: backup, role: 'Backup Invigilator', key: mkKey(exam.id,'backup') });
  }

  if (!toSend.length) {
    console.log(`✅ Nothing due. Now: ${minsToTime(nowMins)} Warsaw · window: ${CFG.notifyMinutes}±8 min before start`);
    return;
  }

  console.log(`📧 Sending ${toSend.length} notification(s)…`);

  // 4. Send
  for (const { exam, person, role, key } of toSend) {
    const params = {
      to_name:        person.name.split(' ')[0],
      to_email:       person.email,
      exam_subject:   exam.syllabus,
      exam_component: exam.component,
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
    } catch(e) {
      console.error(`  ✗ ${person.email}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500)); // rate-limit buffer
  }

  // 5. Save log + prune entries older than 90 days
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
  let pruned = 0;
  for (const k of Object.keys(sentLog)) {
    if (new Date(sentLog[k]) < cutoff) { delete sentLog[k]; pruned++; }
  }
  if (pruned) console.log(`🧹 Pruned ${pruned} old log entries`);
  saveSentLog(sentLog);
  console.log('💾 Sent-log updated');
  console.log('═══ Done ═══\n');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
