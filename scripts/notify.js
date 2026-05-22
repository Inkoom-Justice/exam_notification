/**
 * REGENT EXAM NOTIFIER — notify.js (GitHub Actions Autonomous Engine)
 * Runs daily at 19:00 Warsaw time. Identifies and emails for TOMORROW's exams.
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

/* ── WARSAW TIME SYSTEM ──────────────────────────────────────── */
function getWarsawTomorrowISO() {
  const d = new Date();
  // Force shift offset evaluation to Warsaw zone to prevent execution date boundary mismatches
  const localizedStr = d.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' });
  const tomorrow = new Date(localizedStr);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  const yyyy = tomorrow.getFullYear();
  const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
  const dd = String(tomorrow.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

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
  return `${String(Math.floor(mins / 60) % 24).padStart(2,'0')}:${String(mins % 60).padStart(2,'0')}`;
}

function addMins(timeStr, delta) {
  const base = parseTimeToMins(timeStr);
  if (base == null) return '';
  return minsToTime(base + delta);
}

function fmtDate(d) {
  try { return new Date(d+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}); }
  catch { return d; }
}

/* ── DATA RESOLUTION ─────────────────────────────────────────── */
function resolveInvigilator(rawName) {
  if (!rawName) return null;
  const cleaned = rawName.toString().replace(/\/+$/, '').trim();
  if (!cleaned || cleaned === '-' || cleaned.toLowerCase() === 'nan') return null;
  const found = INVIGILATORS.find(inv => inv.aliases.some(a => a.trim().toLowerCase() === cleaned.toLowerCase()));
  if (found) return { name: found.name, email: `${found.name.toLowerCase().replace(/[^a-z]/g,'')}@${CFG.emailDomain}` };
  const fallbackEmail = `${cleaned.toLowerCase().replace(/\s+/g,'.').replace(/[^a-z.]/g,'')}@${CFG.emailDomain}`;
  return { name: cleaned, email: fallbackEmail };
}

/* ── PARSER ──────────────────────────────────────────────────── */
function csvToRows(csv) {
  const rows = [];
  for (const line of csv.split('\n')) {
    const row = []; let inQ=false, cell='';
    for (const ch of line) {
      if (ch==='"') { inQ=!inQ; }
      else if (ch===',' && !inQ) { row.push(cell.trim()); cell=''; }
      else { cell+=ch; }
    }
    row.push(cell.trim()); rows.push(row);
  }
  return rows;
}

function parseCSV(csv) {
  const rows = csvToRows(csv);
  let hi = -1;
  for (let i=0; i<rows.length; i++) {
    const r = rows[i].map(c=>(c||'').toLowerCase());
    if (r.some(c=>c.includes('start time')) && r.some(c=>c.includes('invigilator'))) { hi=i; break; }
  }
  if (hi===-1) throw new Error("Headers row matching structure could not be identified.");

  const H = rows[hi].map(c=>(c||'').toLowerCase().trim());
  const col = kw => H.findIndex(h => h.includes(kw.toLowerCase()));

  const C = {
    date: col('exam date'), room: col('room'), session: col('session'),
    start: col('start time'), finish: col('finish time'), extFinish: col('ext. finish time'),
    syllabus: col('syllabus'), component: col('component title'), code: col('code'),
    entries: col('entries'), invig: col('exam invigilator'), backup: col('backup invigilator')
  };

  const list = [];
  for (let i=hi+1; i<rows.length; i++) {
    const r = rows[i]; if (!r || r.every(c=>!c)) continue;
    const rawDate = (r[C.date]||'').toString().trim();
    const rawStart = (r[C.start]||'').toString().trim();
    const syllabus = (r[C.syllabus]||'').toString().trim();
    if (!rawDate || !rawStart || !syllabus || rawDate==='NaN') continue;

    let dateStr = '';
    if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) dateStr = rawDate.substring(0,10);
    else if (/^\d{5}$/.test(rawDate)) {
      const serial = parseInt(rawDate) - (parseInt(rawDate) > 59 ? 1 : 0);
      const d = new Date(Date.UTC(1899, 11, 31) + serial * 86400000);
      dateStr = d.toISOString().substring(0,10);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

    const startMins = parseTimeToMins(rawStart); if (startMins == null) continue;
    const finishMins = parseTimeToMins(r[C.finish]);
    const extMins = parseTimeToMins(r[C.extFinish]);

    list.push({
      id: `exam_${dateStr}_${minsToTime(startMins)}_${(r[C.code]||syllabus).replace(/\W/g,'_')}`,
      date: dateStr, startTime: minsToTime(startMins),
      finishTime: finishMins ? minsToTime(finishMins) : '',
      extFinishTime: extMins ? minsToTime(extMins) : '',
      session: C.session>=0 ? r[C.session] : '', room: C.room>=0 ? r[C.room] : '',
      syllabus, component: C.component>=0 ? r[C.component] : '',
      entries: C.entries>=0 ? r[C.entries] : '',
      invigRaw: C.invig>=0 ? r[C.invig] : '', backupRaw: C.backup>=0 ? r[C.backup] : ''
    });
  }
  return list;
}

/* ── NETWORKING ──────────────────────────────────────────────── */
function downloadCSV(url) {
  return new Promise((res, rej) => {
    const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`;
    https.get(proxyUrl, response => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        if (data.includes(',') && data.split('\n').length > 2) return res(data);
        // Fallback directly to direct stream if proxy outputs junk
        https.get(url, r2 => {
          let d2 = ''; r2.on('data', c => d2 += c);
          r2.on('end', () => res(d2));
        }).on('error', rej);
      });
    }).on('error', rej);
  });
}

function sendEmailJS(params) {
  return new Promise((res, rej) => {
    const payload = JSON.stringify({
      user_id: CFG.ejsPublicKey, service_id: CFG.ejsServiceId,
      template_id: CFG.ejsTemplateId, template_params: params
    });
    const req = https.request({
      hostname: 'api.emailjs.com', path: '/api/v1.0/email/send', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, response => {
      let body = '';
      response.on('data', c => body += c);
      response.on('end', () => response.statusCode === 200 ? res() : rej(new Error(body || `HTTP ${response.statusCode}`)));
    });
    req.on('error', rej); req.write(payload); req.end();
  });
}

/* ── RUNTIME EXECUTION ───────────────────────────────────────── */
async function run() {
  console.log(`🚀 Starting Autonomous Scheduler Process…`);
  if (!CFG.sheetsUrl || !CFG.ejsPublicKey || !CFG.ejsServiceId || !CFG.ejsTemplateId) {
    console.error("❌ Missing required operational target parameters. Process aborted.");
    process.exit(1);
  }

  let sentLog = {};
  try { if (fs.existsSync(SENT_LOG)) sentLog = JSON.parse(fs.readFileSync(SENT_LOG, 'utf8')); } catch(e) {}

  const tomorrowStr = getWarsawTomorrowISO();
  console.log(`📅 Targeting exams listed for tomorrow: ${tomorrowStr}`);

  const csv = await downloadCSV(CFG.sheetsUrl);
  const exams = parseCSV(csv);
  const tomorrowExams = exams.filter(e => e.date === tomorrowStr);

  console.log(`🔍 Total database rows mapped matching target date criteria: ${tomorrowExams.length}`);

  let actionsDispatched = 0;
  for (const exam of tomorrowExams) {
    for (const [rawName, role, typeKey] of [
      [exam.invigRaw, 'Main Invigilator', 'main'],
      [exam.backupRaw, 'Backup Invigilator', 'backup']
    ]) {
      const person = resolveInvigilator(rawName);
      if (!person) continue;

      const logKey = `${exam.id}_${typeKey}`;
      // Skip if already managed by manual override interface or prior processing loop
      if (sentLog[logKey]) {
        console.log(`  ⏭ Skipping ${person.email} (${role}) — already notified.`);
        continue;
      }

      console.log(`  📧 Dispatching alert payload to ${person.email} for ${exam.syllabus}…`);
      const payload = {
        to_name:        person.name.split(' ')[0],
        to_email:       person.email,
        exam_subject:   exam.syllabus,
        exam_component: exam.component || '',
        exam_date:      fmtDate(exam.date),
        exam_time:      exam.startTime,
        exam_room:      exam.room || 'TBC',
        finish_time:    exam.finishTime || 'TBC',
        ext_finish:     exam.extFinishTime || 'N/A',
        num_entries:    exam.entries || 'N/A',
        role,
        readiness_time: addMins(exam.startTime, -20)
      };

      try {
        await sendEmailJS(payload);
        // Write status mapping identifier configuration as explicitly "auto"
        sentLog[logKey] = "auto";
        actionsDispatched++;
        console.log(`    ✓ Dispatched successfully.`);
      } catch(err) {
        console.error(`    ✗ Transmission failure: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 600));
    }
  }

  // Retention cleanup optimization maintenance loop
  const ninetyDaysAgo = new Date(); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  for (const k in sentLog) {
    if (sentLog[k] !== "auto" && sentLog[k] !== "manual" && new Date(sentLog[k]) < ninetyDaysAgo) {
      delete sentLog[k];
    }
  }

  fs.mkdirSync(path.dirname(SENT_LOG), { recursive: true });
  fs.writeFileSync(SENT_LOG, JSON.stringify(sentLog, null, 2), 'utf8');
  console.log(`🏁 Operation finalized. Total alerts delivered: ${actionsDispatched}`);
}

run().catch(console.error);
