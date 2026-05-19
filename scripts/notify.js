/**
 * REGENT EXAM NOTIFIER — notify.js
 * ─────────────────────────────────────────────────────────────────
 * Run by GitHub Actions every 15 minutes.
 * - Fetches timetable from Google Sheets (live CSV)
 * - Resolves invigilator names → emails
 * - Sends EmailJS notifications for exams starting in ~60 minutes
 * - Uses a local sent-log file to prevent duplicate sends
 * ─────────────────────────────────────────────────────────────────
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

// ── CONFIG FROM ENVIRONMENT ────────────────────────────────────
const CONFIG = {
  sheetsUrl:      process.env.SHEETS_URL       || '',
  ejsPublicKey:   process.env.EJS_PUBLIC_KEY   || '',
  ejsServiceId:   process.env.EJS_SERVICE_ID   || '',
  ejsTemplateId:  process.env.EJS_TEMPLATE_ID  || '',
  notifyMinutes:  parseInt(process.env.NOTIFY_MINUTES || '60'),
  emailDomain:    process.env.EMAIL_DOMAIN     || 'regent.edu.pl',
  timezone:       process.env.TIMEZONE         || 'Europe/Warsaw',
};

// Path to the sent-log (committed to repo to persist between runs)
const SENT_LOG_PATH = path.join(__dirname, '..', 'data', 'sent-log.json');

// ── INVIGILATOR ALIASES ─────────────────────────────────────────
// Mirrors the data in the admin UI's localStorage.
// This list is used by the GitHub Actions runner (no browser storage).
const INVIGILATORS = [
  { name: 'Anna Martowicz',      aliases: ['AM', 'Anna M', 'Anna Martowicz'] },
  { name: 'Mariusz Krajewski',   aliases: ['Mariusz', 'Krajewski'] },
  { name: 'Anna Santos',         aliases: ['Anna Santos'] },
  { name: 'Marta Szweda',        aliases: ['Marta', 'Marta Szweda'] },
  { name: 'Krzysztof Martowicz', aliases: ['KM', 'Krzysztof', 'Krzysztof Martowicz'] },
  { name: 'Maciej Pyrka',        aliases: ['Maciek', 'Maciek/', 'Maciek//', 'Maciej', 'Maciej Pyrka'] },
  { name: 'Anna Panfil',         aliases: ['Panfil', 'Anna Panfil'] },
  { name: 'Roger Messer',        aliases: ['Roger', 'Roger Messer'] },
  { name: 'Kristy Khemraj',      aliases: ['Kristy', 'Kristy Khemraj', 'Kristy//'] },
  { name: 'Justice Inkoom',      aliases: ['Justice', 'Justice//', 'Justice Inkoom'] },
  { name: 'Zipporah Bvalani',    aliases: ['Zipporah', 'Zipporah//', 'Zipporah Bvalani'] },
  { name: 'Szymon',              aliases: ['Szymon', 'Szymon//'] },
];

// ── HELPERS ─────────────────────────────────────────────────────
function generateEmail(name) {
  const clean = name.replace(/\s*\(.*?\)\s*/g, '').trim();
  const parts = clean.toLowerCase().split(/\s+/);
  if (parts.length >= 2) return `${parts[0]}.${parts[parts.length - 1]}@${CONFIG.emailDomain}`;
  return `${parts[0]}@${CONFIG.emailDomain}`;
}

function resolveInvigilator(raw) {
  if (!raw || raw === '-' || raw === 'NaN') return null;
  const cleaned = raw.replace(/\/+$/, '').trim();
  if (!cleaned) return null;
  const match = INVIGILATORS.find(inv =>
    inv.aliases.some(a => a.toLowerCase() === cleaned.toLowerCase())
  );
  if (match) return { name: match.name, email: generateEmail(match.name) };
  // Fallback: treat the raw value as a name
  return { name: cleaned, email: generateEmail(cleaned) };
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function csvToRows(csv) {
  const rows = [];
  for (const line of csv.split('\n')) {
    const row = [];
    let inQuotes = false, cell = '';
    for (const ch of line) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ',' && !inQuotes) { row.push(cell.trim()); cell = ''; }
      else cell += ch;
    }
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
  } catch { return dateStr; }
}

function calcReadiness(startTime, minsBefore) {
  const [h, m] = startTime.split(':').map(Number);
  const total = h * 60 + m - minsBefore;
  return `${Math.floor(total / 60).toString().padStart(2,'0')}:${(total % 60).toString().padStart(2,'0')}`;
}

function loadSentLog() {
  try {
    if (fs.existsSync(SENT_LOG_PATH)) {
      return JSON.parse(fs.readFileSync(SENT_LOG_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function saveSentLog(log) {
  const dir = path.dirname(SENT_LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SENT_LOG_PATH, JSON.stringify(log, null, 2));
}

function sentKey(examId, role) {
  return `${examId}__${role}`;
}

// ── EMAILJS SEND (REST API) ─────────────────────────────────────
function sendEmailJS(params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      service_id:  CONFIG.ejsServiceId,
      template_id: CONFIG.ejsTemplateId,
      user_id:     CONFIG.ejsPublicKey,
      template_params: params
    });
    const options = {
      hostname: 'api.emailjs.com',
      path:     '/api/v1.0/email/send',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(true);
        else reject(new Error(`EmailJS ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── MAIN ────────────────────────────────────────────────────────
async function main() {
  console.log(`\n═══ Exam Notification Check — ${new Date().toISOString()} ═══`);

  if (!CONFIG.sheetsUrl)    { console.error('❌ SHEETS_URL not set'); process.exit(1); }
  if (!CONFIG.ejsPublicKey) { console.error('❌ EJS_PUBLIC_KEY not set'); process.exit(1); }
  if (!CONFIG.ejsServiceId) { console.error('❌ EJS_SERVICE_ID not set'); process.exit(1); }
  if (!CONFIG.ejsTemplateId){ console.error('❌ EJS_TEMPLATE_ID not set'); process.exit(1); }

  // 1. Fetch timetable CSV
  console.log('📥 Fetching timetable…');
  let csv;
  try { csv = await fetchUrl(CONFIG.sheetsUrl); }
  catch (err) { console.error('❌ Failed to fetch sheet:', err.message); process.exit(1); }

  // 2. Parse CSV
  const rows = csvToRows(csv);
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some(c => c && c.toLowerCase().includes('start time')) &&
        rows[i].some(c => c && c.toLowerCase().includes('exam invigilator'))) {
      headerIdx = i; break;
    }
  }
  if (headerIdx === -1) { console.error('❌ Header row not found in CSV'); process.exit(1); }

  const headers = rows[headerIdx].map(h => h ? h.toLowerCase().trim() : '');
  const col = k => headers.findIndex(h => h.includes(k.toLowerCase()));

  const colDate      = col('exam date');
  const colStart     = col('start time');
  const colRoom      = col('room');
  const colSession   = col('session');
  const colSyllabus  = col('syllabus');
  const colComponent = col('component title');
  const colCode      = col('code');
  const colInvig     = col('exam invigilator');
  const colBackup    = col('backup invigilator');

  const exams = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(c => !c)) continue;
    const rawDate  = r[colDate]  || '';
    const rawStart = r[colStart] || '';
    const syllabus = (r[colSyllabus] || '').trim();
    if (!rawDate || !rawStart || rawDate === 'NaN' || !syllabus) continue;

    let dateStr = '';
    try {
      const d = new Date(rawDate);
      if (!isNaN(d)) dateStr = d.toISOString().split('T')[0];
    } catch {}
    if (!dateStr) continue;

    let startTime = '';
    if (typeof rawStart === 'string' && rawStart.includes(':')) {
      startTime = rawStart.substring(0, 5);
    }
    if (!startTime) continue;

    const code    = (r[colCode] || '').trim();
    const examId  = `exam_${dateStr}_${startTime}_${(code || syllabus).replace(/\s/g,'_')}`;
    exams.push({
      id:        examId,
      date:      dateStr,
      startTime,
      room:      (r[colRoom]      || '').trim(),
      session:   (r[colSession]   || '').trim(),
      syllabus,
      component: (r[colComponent] || '').trim(),
      invigRaw:  (r[colInvig]     || '').trim(),
      backupRaw: (r[colBackup]    || '').trim(),
    });
  }
  console.log(`📋 Parsed ${exams.length} exams from timetable`);

  // 3. Find exams in notification window
  const now   = new Date();
  const sentLog = loadSentLog();
  const toSend  = [];

  for (const exam of exams) {
    const examDT = new Date(`${exam.date}T${exam.startTime}:00`);
    const mins   = (examDT - now) / 60000;

    // Window: notifyMinutes ± 8 min (runs every 15 min, so 8-min buffer avoids gaps/doubles)
    const lo = CONFIG.notifyMinutes - 8;
    const hi = CONFIG.notifyMinutes + 8;
    if (mins < lo || mins > hi) continue;

    const invig  = resolveInvigilator(exam.invigRaw);
    const backup = resolveInvigilator(exam.backupRaw);

    if (invig && !sentLog[sentKey(exam.id, 'main')]) {
      toSend.push({ exam, person: invig, role: 'Main Invigilator', key: sentKey(exam.id, 'main') });
    }
    if (backup && !sentLog[sentKey(exam.id, 'backup')]) {
      toSend.push({ exam, person: backup, role: 'Backup Invigilator', key: sentKey(exam.id, 'backup') });
    }
  }

  if (!toSend.length) {
    console.log('✅ No notifications due right now.');
    return;
  }

  console.log(`📧 Sending ${toSend.length} notification(s)…`);

  // 4. Send emails
  for (const item of toSend) {
    const { exam, person, role, key } = item;
    const params = {
      to_name:        person.name.split(' ')[0],
      to_email:       person.email,
      exam_subject:   exam.syllabus,
      exam_component: exam.component,
      exam_date:      formatDate(exam.date),
      exam_time:      exam.startTime,
      exam_room:      exam.room || 'TBC',
      role,
      readiness_time: calcReadiness(exam.startTime, 20)
    };

    try {
      await sendEmailJS(params);
      sentLog[key] = new Date().toISOString();
      console.log(`  ✓ Sent to ${person.email} (${role}) for ${exam.syllabus} ${exam.date} ${exam.startTime}`);
    } catch (err) {
      console.error(`  ✗ Failed for ${person.email}: ${err.message}`);
    }

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  // 5. Save sent log
  saveSentLog(sentLog);
  console.log('💾 Sent-log updated.');

  // 6. Prune old entries from log (keep last 90 days)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  let pruned = 0;
  for (const k of Object.keys(sentLog)) {
    if (new Date(sentLog[k]) < cutoff) { delete sentLog[k]; pruned++; }
  }
  if (pruned) { saveSentLog(sentLog); console.log(`🧹 Pruned ${pruned} old log entries`); }

  console.log('═══ Done ═══\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
