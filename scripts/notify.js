/**
 * REGENT EXAM NOTIFIER — notify.js (GitHub Actions Autonomous Engine)
 * Runs daily at 19:00 Warsaw time. Identifies and emails for TOMORROW's exams.
 *
 * DATA SOURCE PRIORITY:
 *   1. Firebase Firestore (clean, pre-validated data already in the system)
 *   2. Google Sheets CSV (fallback only if Firestore has no exams)
 *
 * This means the spreadsheet no longer needs to be intact at notification time.
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
  ejsPrivateKey: process.env.EMAILJS_PRIVATE_KEY || '',
  emailDomain:   process.env.EMAIL_DOMAIN     || 'regent.edu.pl',
  firebaseSA:    process.env.FIREBASE_SERVICE_ACCOUNT || '',
  projectId:     process.env.FIREBASE_PROJECT_ID || 'regent-exam-notifier',
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
function getWarsawTomorrowISO() {
  const d = new Date();
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
  let s = raw.toString().trim();
  if (/^\d+\.\d+$/.test(s)) return Math.round(parseFloat(s) * 24 * 60);
  s = s.replace(/^~+\s*/, '');
  s = s.replace(/^\s*(circa|approx(?:imately)?|around|about|est\.?|c\.)\s*/i, '').trim();
  const ampmMatch = s.match(/\b(a\.?m\.?|p\.?m\.?)\b/i);
  const ampm = ampmMatch ? ampmMatch[1].replace(/\./g, '').toLowerCase() : null;
  s = s.replace(/\b(a\.?m\.?|p\.?m\.?)\b/i, '').trim();
  const match = s.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?/);
  if (!match) return null;
  let h = parseInt(match[1]);
  const m = match[2] ? parseInt(match[2]) : 0;
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return h * 60 + m;
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

/* ── INVIGILATOR RESOLUTION ──────────────────────────────────── */
function resolveInvigilator(rawName) {
  if (!rawName) return null;
  const cleaned = rawName.toString().replace(/\/+$/, '').trim();
  if (!cleaned || cleaned === '-' || cleaned.toLowerCase() === 'nan') return null;
  const found = INVIGILATORS.find(inv => inv.aliases.some(a => a.trim().toLowerCase() === cleaned.toLowerCase()));
  if (found) return { name: found.name, email: `${found.name.toLowerCase().replace(/[^a-z]/g,'')}@${CFG.emailDomain}` };
  const fallbackEmail = `${cleaned.toLowerCase().replace(/\s+/g,'.').replace(/[^a-z.]/g,'')}@${CFG.emailDomain}`;
  return { name: cleaned, email: fallbackEmail };
}

/* ── FIRESTORE REST API ───────────────────────────────────────── */
// Uses Firebase Admin SDK via service account — no spreadsheet dependency.

async function getAccessToken(serviceAccount) {
  // Create a JWT and exchange it for a Google access token
  const { private_key, client_email } = serviceAccount;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  // Encode JWT manually (no external dependencies)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body   = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const unsigned = `${header}.${body}`;

  const crypto = require('crypto');
  const sign   = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(private_key, 'base64url');
  const jwt = `${unsigned}.${signature}`;

  // Exchange JWT for access token
  return new Promise((res, rej) => {
    const postData = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.access_token) res(parsed.access_token);
          else rej(new Error(parsed.error_description || 'Token exchange failed'));
        } catch(e) { rej(e); }
      });
    });
    req.on('error', rej);
    req.write(postData);
    req.end();
  });
}

async function getExamsFromFirestore() {
  if (!CFG.firebaseSA) {
    console.log('  ℹ No FIREBASE_SERVICE_ACCOUNT secret — skipping Firestore.');
    return null;
  }
  try {
    const serviceAccount = JSON.parse(CFG.firebaseSA);
    const token = await getAccessToken(serviceAccount);
    const projectId = serviceAccount.project_id || CFG.projectId;

    return new Promise((res, rej) => {
      const firestorePath = `/v1/projects/${projectId}/databases/(default)/documents/appdata/exams`;
      https.get({
        hostname: 'firestore.googleapis.com',
        path:     firestorePath,
        headers:  { 'Authorization': `Bearer ${token}` }
      }, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => {
          try {
            const doc = JSON.parse(d);
            if (doc.error) { console.warn('  ⚠ Firestore error:', doc.error.message); return res(null); }
            // Firestore stores arrays as { arrayValue: { values: [...] } }
            const arrayValues = doc.fields?.value?.arrayValue?.values || [];
            const exams = arrayValues.map(v => {
              const fields = v.mapValue?.fields || {};
              const str = k => fields[k]?.stringValue || '';
              const bool = k => fields[k]?.booleanValue || false;
              return {
                id:            str('id'),
                date:          str('date'),
                startTime:     str('startTime'),
                finishTime:    str('finishTime'),
                extFinishTime: str('extFinishTime'),
                room:          str('room'),
                session:       str('session'),
                syllabus:      str('syllabus'),
                component:     str('component'),
                entries:       str('entries'),
                invigRaw:      str('invigRaw'),
                backupRaw:     str('backupRaw'),
                notifiedMain:  fields['notifiedMain']?.stringValue || bool('notifiedMain'),
                notifiedBackup:fields['notifiedBackup']?.stringValue || bool('notifiedBackup'),
              };
            }).filter(e => e.date && e.syllabus);
            console.log(`  ☁ Loaded ${exams.length} exams from Firestore ✓`);
            res(exams.length > 0 ? exams : null);
          } catch(e) { console.warn('  ⚠ Firestore parse error:', e.message); res(null); }
        });
      }).on('error', e => { console.warn('  ⚠ Firestore request error:', e.message); res(null); });
    });
  } catch(e) {
    console.warn('  ⚠ Firestore access failed:', e.message);
    return null;
  }
}

/* ── GOOGLE SHEETS FALLBACK ──────────────────────────────────── */
function downloadCSV(url) {
  return new Promise((res, rej) => {
    const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`;
    https.get(proxyUrl, response => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        if (data.includes(',') && data.split('\n').length > 2) return res(data);
        https.get(url, r2 => {
          let d2 = ''; r2.on('data', c => d2 += c);
          r2.on('end', () => res(d2));
        }).on('error', rej);
      });
    }).on('error', rej);
  });
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
  const col     = kw => H.findIndex(h => h.includes(kw.toLowerCase()));
  const colLast = kw => { let idx=-1; H.forEach((h,i)=>{ if(h.includes(kw.toLowerCase())) idx=i; }); return idx; };

  const C = {
    date:      colLast('exam date'),
    room:      col('room'),
    session:   col('session'),
    start:     col('start time'),
    finish:    col('finish time'),
    extFinish: col('ext. finish time'),
    syllabus:  col('syllabus'),
    component: col('component title'),
    code:      col('code'),
    entries:   6,
    invig:     col('exam invigilator'),
    backup:    col('backup invigilator'),
  };

  const list = [];
  const seenIds = new Set();
  for (let i=hi+1; i<rows.length; i++) {
    const r = rows[i]; if (!r || r.every(c=>!c)) continue;
    const rawDate  = (r[C.date]||'').toString().trim();
    const rawStart = (r[C.start]||'').toString().trim();
    const syllabus = (r[C.syllabus]||'').toString().trim();
    if (!rawDate || !rawStart || !syllabus || rawDate==='NaN') continue;

    let dateStr = '';
    if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) dateStr = rawDate.substring(0,10);
    else if (/^\d{2}\/\d{2}\/\d{4}$/.test(rawDate)) {
      const [d,m,y] = rawDate.split('/'); dateStr = `${y}-${m}-${d}`;
    }
    else if (/^\d{2}\/\d{2}\/\d{2}$/.test(rawDate)) {
      const [d,m,y] = rawDate.split('/'); dateStr = `20${y}-${m}-${d}`;
    }
    else {
      const MONTHS = {
        january:'01',february:'02',march:'03',april:'04',
        may:'05',june:'06',july:'07',august:'08',
        september:'09',october:'10',november:'11',december:'12',
        jan:'01',feb:'02',mar:'03',apr:'04',
        jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'
      };
      let s = rawDate.replace(/,/g,'').trim();
      if (/^[A-Za-z]+\s+\d/.test(s)) s = s.replace(/^[A-Za-z]+\s+/,'');
      const p = s.split(/\s+/);
      if (p.length === 3 && /^\d{1,2}$/.test(p[0]) && /^[A-Za-z]+$/.test(p[1]) && /^\d{2,4}$/.test(p[2])) {
        const mon = MONTHS[p[1].toLowerCase()] || MONTHS[p[1].toLowerCase().substring(0,3)];
        if (mon) {
          const yr = p[2].length === 2 ? '20'+p[2] : p[2];
          dateStr  = `${yr}-${mon}-${p[0].padStart(2,'0')}`;
        }
      }
      if (!dateStr && /^\d{5}$/.test(rawDate)) {
        const serial = parseInt(rawDate) - (parseInt(rawDate) > 59 ? 1 : 0);
        const d = new Date(Date.UTC(1899,11,31) + serial * 86400000);
        dateStr = d.toISOString().substring(0,10);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

    const startMins = parseTimeToMins(rawStart); if (startMins == null) continue;
    const finishMins   = parseTimeToMins(r[C.finish]);
    const extMins      = parseTimeToMins(r[C.extFinish]);

    let id = `exam_${dateStr}`;
    if (seenIds.has(id)) { let n=2; while(seenIds.has(`${id}_${n}`)) n++; id=`${id}_${n}`; }
    seenIds.add(id);

    list.push({
      id, date: dateStr,
      startTime:    minsToTime(startMins),
      finishTime:   finishMins ? minsToTime(finishMins) : '',
      extFinishTime:extMins    ? minsToTime(extMins)    : '',
      session:   C.session>=0 ? r[C.session] : '',
      room:      C.room>=0    ? r[C.room]    : '',
      syllabus,
      component: C.component>=0 ? r[C.component] : '',
      entries:   C.entries>=0   ? r[C.entries]   : '',
      invigRaw:  C.invig>=0     ? r[C.invig]     : '',
      backupRaw: C.backup>=0    ? r[C.backup]     : '',
    });
  }
  return list;
}

/* ── EMAILJS ─────────────────────────────────────────────────── */
function sendEmailJS(params) {
  return new Promise((res, rej) => {
    const payload = JSON.stringify({
      user_id: CFG.ejsPublicKey, service_id: CFG.ejsServiceId,
      template_id: CFG.ejsTemplateId, template_params: params,
      accessToken: CFG.ejsPrivateKey
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

/* ── MAIN ────────────────────────────────────────────────────── */
async function run() {
  console.log(`🚀 Starting Autonomous Scheduler Process…`);

  if (!CFG.ejsPublicKey || !CFG.ejsServiceId || !CFG.ejsTemplateId) {
    console.error("❌ Missing EmailJS configuration. Process aborted.");
    process.exit(1);
  }

  let sentLog = {};
  try { if (fs.existsSync(SENT_LOG)) sentLog = JSON.parse(fs.readFileSync(SENT_LOG, 'utf8')); } catch(e) {}

  const tomorrowStr = getWarsawTomorrowISO();
  console.log(`📅 Targeting exams for tomorrow: ${tomorrowStr}`);

  // ── Step 1: Try Firestore ─────────────────────────────────────
  let allExams = await getExamsFromFirestore();
  let source = 'Firestore';

  // ── Step 2: Fall back to Google Sheets if needed ──────────────
  if (!allExams) {
    if (!CFG.sheetsUrl) {
      console.error("❌ No Firestore data and no SHEETS_URL configured. Cannot proceed.");
      process.exit(1);
    }
    console.log(`  📊 Falling back to Google Sheets CSV…`);
    try {
      const csv = await downloadCSV(CFG.sheetsUrl);
      allExams = parseCSV(csv);
      source = 'Google Sheets';
      console.log(`  ✓ Loaded ${allExams.length} exams from Google Sheets`);
    } catch(e) {
      console.error(`  ❌ Google Sheets fallback also failed: ${e.message}`);
      process.exit(1);
    }
  }

  const tomorrowExams = allExams.filter(e => e.date === tomorrowStr);
  console.log(`🔍 Source: ${source} | Total exams: ${allExams.length} | Tomorrow: ${tomorrowExams.length}`);

  if (tomorrowExams.length === 0) {
    console.log(`✅ No exams scheduled for ${tomorrowStr}. Nothing to send.`);
    fs.mkdirSync(path.dirname(SENT_LOG), { recursive: true });
    fs.writeFileSync(SENT_LOG, JSON.stringify(sentLog, null, 2), 'utf8');
    return;
  }

  let actionsDispatched = 0;
  for (const exam of tomorrowExams) {
    for (const [rawName, role, typeKey] of [
      [exam.invigRaw,  'Main Invigilator',   'main'],
      [exam.backupRaw, 'Backup Invigilator',  'backup'],
    ]) {
      const person = resolveInvigilator(rawName);
      if (!person) continue;

      const logKey = `${exam.id}_${typeKey}`;
      if (sentLog[logKey]) {
        console.log(`  ⏭ Skipping ${person.email} (${role}) — already notified.`);
        continue;
      }

      console.log(`  📧 Sending to ${person.email} for ${exam.syllabus}…`);
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
        readiness_time: addMins(exam.startTime, -20),
      };

      try {
        await sendEmailJS(payload);
        sentLog[logKey] = 'auto';
        actionsDispatched++;
        console.log(`    ✓ Sent successfully.`);
      } catch(err) {
        console.error(`    ✗ Failed: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 600));
    }
  }

  // Cleanup old log entries
  const ninetyDaysAgo = new Date(); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  for (const k in sentLog) {
    if (sentLog[k] !== 'auto' && sentLog[k] !== 'manual' && new Date(sentLog[k]) < ninetyDaysAgo) {
      delete sentLog[k];
    }
  }

  fs.mkdirSync(path.dirname(SENT_LOG), { recursive: true });
  fs.writeFileSync(SENT_LOG, JSON.stringify(sentLog, null, 2), 'utf8');
  console.log(`🏁 Done. Alerts delivered: ${actionsDispatched}`);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
