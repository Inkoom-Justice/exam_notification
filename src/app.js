/* ═══════════════════════════════════════════════════════════
   REGENT EXAM NOTIFIER — app.js
   Full client-side application logic
   ═══════════════════════════════════════════════════════════ */

'use strict';

// ─── STORAGE HELPERS ───────────────────────────────────────────
const S = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  del: k => localStorage.removeItem(k)
};

// ─── DEFAULT INVIGILATORS (from the photo + sheet) ─────────────
const DEFAULT_INVIGILATORS = [
  { id: 'inv_1',  name: 'Anna Martowicz',     email: '', aliases: ['AM', 'Anna M', 'Anna Martowicz'], active: true },
  { id: 'inv_2',  name: 'Mariusz Krajewski',  email: '', aliases: ['Mariusz', 'Krajewski'], active: true },
  { id: 'inv_3',  name: 'Anna Santos',        email: '', aliases: ['Anna Santos'], active: true },
  { id: 'inv_4',  name: 'Marta Szweda',       email: '', aliases: ['Marta', 'Marta Szweda'], active: true },
  { id: 'inv_5',  name: 'Krzysztof Martowicz',email: '', aliases: ['KM', 'Krzysztof', 'Krzysztof Martowicz'], active: true },
  { id: 'inv_6',  name: 'Maciej Pyrka',       email: '', aliases: ['Maciek', 'Maciek/', 'Maciek//', 'Maciej', 'Maciej Pyrka'], active: true },
  { id: 'inv_7',  name: 'Anna Panfil',        email: '', aliases: ['Panfil', 'Anna Panfil'], active: true },
  { id: 'inv_8',  name: 'Roger Messer',       email: '', aliases: ['Roger', 'Roger Messer'], active: true },
  { id: 'inv_9',  name: 'Kristy Khemraj',     email: '', aliases: ['Kristy', 'Kristy Khemraj', 'Kristy//', 'Kristy//'], active: true },
  { id: 'inv_10', name: 'Justice Inkoom',     email: '', aliases: ['Justice', 'Justice//', 'Justice Inkoom'], active: true },
  { id: 'inv_11', name: 'Zipporah Bvalani',   email: '', aliases: ['Zipporah', 'Zipporah//', 'Zipporah Bvalani'], active: true },
  { id: 'inv_12', name: 'Szymon',             email: '', aliases: ['Szymon', 'Szymon//'], active: true },
];

// ─── APP STATE ─────────────────────────────────────────────────
let exams = S.get('exams') || [];
let invigilators = S.get('invigilators') || DEFAULT_INVIGILATORS;
let notifLog = S.get('notifLog') || [];
let editingId = null;

// ─── SETTINGS ──────────────────────────────────────────────────
function getSettings() {
  return S.get('settings') || {
    sheetsUrl: '',
    sheetsGid: '1559134635',
    ejsPublicKey: '',
    ejsServiceId: '',
    ejsTemplateId: '',
    notifyMinutes: 60,
    emailDomain: 'regent.edu.pl',
    timezone: 'Europe/Warsaw',
    pin: '1234'
  };
}

// ─── AUTH ───────────────────────────────────────────────────────
function login() {
  const pinInput = document.getElementById('pinInput');
  const pin = pinInput.value.trim();
  const settings = getSettings();

  if (!pin) {
    showLoginError('Please enter your PIN.');
    return;
  }

  if (pin === settings.pin) {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    clearLoginError();
    initApp();
  } else {
    showLoginError('Incorrect PIN. Please try again.');
    pinInput.value = '';
    pinInput.focus();
  }
}

function showLoginError(msg) {
  let el = document.getElementById('loginError');
  if (!el) {
    el = document.createElement('p');
    el.id = 'loginError';
    el.style.cssText = 'color:#C8392B;font-size:13px;margin-top:10px;font-weight:500;';
    document.querySelector('.login-card').appendChild(el);
  }
  el.textContent = msg;
}

function clearLoginError() {
  const el = document.getElementById('loginError');
  if (el) el.textContent = '';
}

// Attach keydown after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const pinInput = document.getElementById('pinInput');
  if (pinInput) {
    pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
    pinInput.focus();
  }
});

function logout() {
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  const pinInput = document.getElementById('pinInput');
  if (pinInput) { pinInput.value = ''; pinInput.focus(); }
  clearLoginError();
}

// ─── INIT ───────────────────────────────────────────────────────
function initApp() {
  renderInvigilators();
  renderDashboard();
  renderTimetable();
  renderLog();
  loadSettingsUI();
  updateStats();
}

// ─── TAB SWITCHING ──────────────────────────────────────────────
function switchTab(tab, el) {
  document.querySelectorAll('.tab-section').forEach(s => s.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.remove('hidden');
  el.classList.add('active');
}

// ─── EMAIL GENERATION ──────────────────────────────────────────
function generateEmail(name, domain) {
  // firstname.surname@domain
  const clean = name.replace(/\s*\(.*?\)\s*/g, '').trim(); // remove "(reception)" etc
  const parts = clean.toLowerCase().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]}.${parts[parts.length - 1]}@${domain}`;
  }
  return `${parts[0]}@${domain}`;
}

function resolveEmail(inv) {
  if (inv.email && inv.email.trim()) return inv.email.trim();
  const domain = getSettings().emailDomain || 'regent.edu.pl';
  return generateEmail(inv.name, domain);
}

// ─── NAME → INVIGILATOR RESOLVER ───────────────────────────────
function resolveInvigilator(rawName) {
  if (!rawName || rawName === '-' || rawName === 'NaN') return null;
  // Strip trailing // and similar
  const cleaned = rawName.replace(/\/+$/, '').trim();
  if (!cleaned) return null;
  return invigilators.find(inv =>
    inv.active &&
    inv.aliases.some(a => a.toLowerCase() === cleaned.toLowerCase())
  ) || { name: cleaned, email: generateEmail(cleaned, getSettings().emailDomain), id: null };
}

// ─── GOOGLE SHEETS FETCH ────────────────────────────────────────
// Multiple CORS proxies tried in order — if one fails, the next is used.
const CORS_PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  url => `https://thingproxy.freeboard.io/fetch/${encodeURIComponent(url)}`,
];

async function fetchWithProxyFallback(url) {
  let lastErr = null;
  for (const proxyFn of CORS_PROXIES) {
    const proxyUrl = proxyFn(url);
    try {
      const res = await Promise.race([
        fetch(proxyUrl),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 8000))
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // allorigins wraps in JSON; others return raw text
      try {
        const json = JSON.parse(text);
        if (json.contents) return json.contents;
      } catch {}
      // If it looks like CSV (has commas and newlines), use it directly
      if (text.includes(',') && text.includes('\n')) return text;
      throw new Error('Response does not look like CSV');
    } catch (err) {
      lastErr = err;
      console.warn(`Proxy failed (${proxyUrl.slice(0, 40)}…): ${err.message}`);
    }
  }
  throw new Error(`All proxies failed. Last error: ${lastErr?.message}`);
}

async function fetchTimetable() {
  const settings = getSettings();
  const url = settings.sheetsUrl;

  showSyncStatus('⏳ Fetching timetable from Google Sheets…', 'info');

  if (!url) {
    showSyncStatus('❌ No Google Sheets URL configured. Go to Settings → Google Sheets.', 'err');
    return;
  }

  try {
    const csv = await fetchWithProxyFallback(url);
    parseTimetableCSV(csv);
  } catch (err) {
    showSyncStatus(
      `❌ Could not fetch the sheet: ${err.message}. ` +
      `Make sure the sheet is published (File → Share → Publish to web → CSV) and the URL is correct.`,
      'err'
    );
  }
}

function parseTimetableCSV(csv) {
  const rows = csvToRows(csv);
  // Find the header row: look for "Exam Date" and "Start time"
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.some(c => c && c.toString().toLowerCase().includes('start time')) &&
        row.some(c => c && c.toString().toLowerCase().includes('exam invigilator'))) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    showSyncStatus('❌ Could not find timetable headers. Check the sheet URL and GID.', 'err');
    return;
  }

  const headers = rows[headerIdx].map(h => h ? h.toString().trim().toLowerCase() : '');

  // Column index finder
  const col = keyword => headers.findIndex(h => h.includes(keyword.toLowerCase()));

  const colDate      = col('exam date');
  const colStart     = col('start time');
  const colRoom      = col('room');
  const colSession   = col('session');
  const colSyllabus  = col('syllabus');
  const colComponent = col('component title');
  const colQual      = headers.findIndex(h => h === '' || h.includes('qualification') || h.includes('gcse') || h.includes('igcse'));
  const colInvig     = col('exam invigilator');
  const colBackup    = col('backup invigilator');
  const colReadiness = col('full-readiness');
  const colCode      = col('code');

  const parsed = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => !c)) continue;

    const rawDate  = row[colDate]   || '';
    const rawStart = row[colStart]  || '';
    const syllabus = row[colSyllabus] ? row[colSyllabus].toString().trim() : '';
    const component= row[colComponent] ? row[colComponent].toString().trim() : '';

    if (!rawDate || !rawStart || rawDate.toString() === 'NaN' || !syllabus) continue;

    // Parse date — handle both JS Date objects (from xlsx) and strings
    let dateStr = '';
    try {
      const d = new Date(rawDate);
      if (!isNaN(d)) {
        dateStr = d.toISOString().split('T')[0]; // YYYY-MM-DD
      }
    } catch { continue; }
    if (!dateStr) continue;

    // Parse start time
    let startTime = '';
    try {
      if (typeof rawStart === 'string' && rawStart.includes(':')) {
        startTime = rawStart.substring(0, 5); // HH:MM
      } else if (rawStart instanceof Date || !isNaN(new Date(rawStart))) {
        const t = new Date(rawStart);
        if (!isNaN(t)) {
          const h = t.getUTCHours().toString().padStart(2, '0');
          const m = t.getUTCMinutes().toString().padStart(2, '0');
          startTime = `${h}:${m}`;
        }
      }
    } catch { }
    if (!startTime) continue;

    const room      = row[colRoom]     ? row[colRoom].toString().trim()     : '';
    const session   = row[colSession]  ? row[colSession].toString().trim()  : '';
    const invigRaw  = row[colInvig]    ? row[colInvig].toString().trim()    : '';
    const backupRaw = row[colBackup]   ? row[colBackup].toString().trim()   : '';
    const readiness = row[colReadiness]? row[colReadiness].toString().trim(): '';
    const code      = row[colCode]     ? row[colCode].toString().trim()     : '';

    parsed.push({
      id: `exam_${dateStr}_${startTime}_${code || syllabus}`.replace(/\s/g, '_'),
      date: dateStr,
      startTime,
      room,
      session,
      syllabus,
      component,
      code,
      invigRaw,
      backupRaw,
      readiness,
      notifiedMain: false,
      notifiedBackup: false
    });
  }

  if (parsed.length === 0) {
    showSyncStatus('⚠️ Sheet fetched but no valid exam rows found. Check the GID points to the correct sheet tab.', 'err');
    return;
  }

  // Preserve notification state for exams that already exist
  const existing = new Map(exams.map(e => [e.id, e]));
  exams = parsed.map(e => {
    const prev = existing.get(e.id);
    return prev ? { ...e, notifiedMain: prev.notifiedMain, notifiedBackup: prev.notifiedBackup } : e;
  });

  S.set('exams', exams);
  renderDashboard();
  renderTimetable();
  updateStats();
  showSyncStatus(`✅ Synced successfully — ${exams.length} exams loaded from Google Sheets.`, 'ok');
  showToast(`${exams.length} exams loaded`, 'success');
}

// ─── CSV PARSER ─────────────────────────────────────────────────
function csvToRows(csv) {
  const rows = [];
  const lines = csv.split('\n');
  for (const line of lines) {
    const row = [];
    let inQuotes = false, cell = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; }
      else if (ch === ',' && !inQuotes) { row.push(cell.trim()); cell = ''; }
      else { cell += ch; }
    }
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}

// ─── DASHBOARD ──────────────────────────────────────────────────
function renderDashboard() {
  const today = getTodayStr();
  const todayExams = exams.filter(e => e.date === today);

  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 2);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  const upcomingExams = exams.filter(e => e.date > today && e.date <= tomorrowStr);

  renderExamList('todayExams', todayExams, true);
  renderExamList('upcomingExams', upcomingExams, false);
}

function renderExamList(containerId, list, showActions) {
  const container = document.getElementById(containerId);
  if (!list.length) {
    container.innerHTML = '<p class="empty-state">No exams for this period.</p>';
    return;
  }
  container.innerHTML = list.map(exam => {
    const invig = resolveInvigilator(exam.invigRaw);
    const backup = resolveInvigilator(exam.backupRaw);
    const status = getNotifStatus(exam);
    return `
      <div class="exam-card">
        <div class="exam-time-badge">
          ${exam.startTime}
          <span class="session-tag">${exam.session || '—'}</span>
        </div>
        <div class="exam-info">
          <div class="exam-subject">${exam.syllabus}</div>
          <div class="exam-component">${exam.component || ''}</div>
          <div class="exam-meta">
            ${exam.room ? `<span class="tag tag-room">📍 ${exam.room}</span>` : ''}
            ${invig ? `<span class="tag tag-invig">👤 ${invig.name}</span>` : ''}
            ${backup ? `<span class="tag tag-backup">🔁 ${backup.name}</span>` : ''}
          </div>
        </div>
        <div class="exam-actions">
          <span class="notif-status ${status.cls}">${status.label}</span>
          ${showActions ? `<button class="btn-icon" title="Send notification now" onclick="manualNotify('${exam.id}')">📧</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

function getNotifStatus(exam) {
  if (exam.notifiedMain && exam.notifiedBackup) return { cls: 'notif-sent', label: '✓ Notified' };
  if (exam.notifiedMain) return { cls: 'notif-sent', label: '✓ Main notified' };
  const now = new Date();
  const examDT = new Date(`${exam.date}T${exam.startTime}:00`);
  if (examDT < now) return { cls: 'notif-pending', label: '⚠ Missed?' };
  const minutesUntil = (examDT - now) / 60000;
  const settings = getSettings();
  if (minutesUntil <= settings.notifyMinutes) return { cls: 'notif-pending', label: '⏰ Due soon' };
  return { cls: 'notif-future', label: `In ${Math.round(minutesUntil / 60)}h` };
}

// ─── TIMETABLE ──────────────────────────────────────────────────
function renderTimetable() {
  const container = document.getElementById('timetableContainer');
  const q = (document.getElementById('searchExams')?.value || '').toLowerCase();
  let filtered = exams;
  if (q) {
    filtered = exams.filter(e =>
      e.syllabus.toLowerCase().includes(q) ||
      e.component.toLowerCase().includes(q) ||
      e.date.includes(q) ||
      e.room.toLowerCase().includes(q) ||
      e.invigRaw.toLowerCase().includes(q) ||
      e.backupRaw.toLowerCase().includes(q)
    );
  }

  if (!filtered.length) {
    container.innerHTML = '<p class="empty-state padded">No exams found.</p>';
    return;
  }

  const rows = filtered.map(e => {
    const invig = resolveInvigilator(e.invigRaw);
    const backup = resolveInvigilator(e.backupRaw);
    const status = getNotifStatus(e);
    return `
      <tr>
        <td><strong>${formatDate(e.date)}</strong></td>
        <td>${e.startTime}</td>
        <td>${e.session || '—'}</td>
        <td>${e.syllabus}</td>
        <td style="color:var(--text-2);font-size:12px">${e.component}</td>
        <td><span class="tag tag-room">${e.room || '—'}</span></td>
        <td>${invig ? `<span class="tag tag-invig">${invig.name}</span>` : '<span style="color:var(--text-3)">—</span>'}</td>
        <td>${backup ? `<span class="tag tag-backup">${backup.name}</span>` : '<span style="color:var(--text-3)">—</span>'}</td>
        <td><span class="notif-status ${status.cls}">${status.label}</span></td>
        <td>
          <button class="btn-icon" title="Send notification now" onclick="manualNotify('${e.id}')">📧</button>
        </td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Start</th>
          <th>Session</th>
          <th>Subject</th>
          <th>Component</th>
          <th>Room</th>
          <th>Main Invigilator</th>
          <th>Backup</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ─── INVIGILATORS ───────────────────────────────────────────────
function renderInvigilators() {
  const tbody = document.getElementById('invigilatorBody');
  tbody.innerHTML = invigilators.map(inv => `
    <tr>
      <td><strong>${inv.name}</strong></td>
      <td style="font-size:12px;color:var(--text-2)">${resolveEmail(inv)}</td>
      <td style="font-size:12px;color:var(--text-3)">${inv.aliases.join(', ')}</td>
      <td><span class="${inv.active ? 'badge-active' : 'badge-inactive'}">${inv.active ? '● Active' : '○ Inactive'}</span></td>
      <td>
        <button class="btn-icon" onclick="openEditModal('${inv.id}')">✏️</button>
        <button class="btn-danger" onclick="deleteInvigilator('${inv.id}')">🗑</button>
      </td>
    </tr>`).join('');
}

function openAddModal() {
  editingId = null;
  document.getElementById('modalTitle').textContent = 'Add Invigilator';
  document.getElementById('mName').value = '';
  document.getElementById('mEmail').value = '';
  document.getElementById('mAliases').value = '';
  document.getElementById('mActive').value = 'true';
  document.getElementById('invigModal').classList.remove('hidden');
}

function openEditModal(id) {
  const inv = invigilators.find(i => i.id === id);
  if (!inv) return;
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Edit Invigilator';
  document.getElementById('mName').value = inv.name;
  document.getElementById('mEmail').value = inv.email || '';
  document.getElementById('mAliases').value = inv.aliases.join(', ');
  document.getElementById('mActive').value = inv.active ? 'true' : 'false';
  document.getElementById('invigModal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('invigModal').classList.add('hidden');
  editingId = null;
}

function saveInvigilator() {
  const name = document.getElementById('mName').value.trim();
  if (!name) { showToast('Name is required', 'error'); return; }
  const email   = document.getElementById('mEmail').value.trim();
  const aliases = document.getElementById('mAliases').value.split(',').map(a => a.trim()).filter(Boolean);
  const active  = document.getElementById('mActive').value === 'true';

  if (editingId) {
    const idx = invigilators.findIndex(i => i.id === editingId);
    if (idx !== -1) invigilators[idx] = { ...invigilators[idx], name, email, aliases, active };
  } else {
    invigilators.push({
      id: 'inv_' + Date.now(),
      name, email, aliases, active
    });
  }
  S.set('invigilators', invigilators);
  renderInvigilators();
  updateStats();
  closeModal();
  showToast(editingId ? 'Invigilator updated' : 'Invigilator added', 'success');
}

function deleteInvigilator(id) {
  if (!confirm('Delete this invigilator?')) return;
  invigilators = invigilators.filter(i => i.id !== id);
  S.set('invigilators', invigilators);
  renderInvigilators();
  updateStats();
  showToast('Invigilator deleted');
}

// ─── NOTIFICATION ENGINE ────────────────────────────────────────
async function runNotificationCheck() {
  const settings = getSettings();
  if (!settings.ejsPublicKey || !settings.ejsServiceId || !settings.ejsTemplateId) {
    setTestResult('❌ EmailJS is not configured. Go to Settings → EmailJS Config.', 'err');
    return;
  }

  emailjs.init(settings.ejsPublicKey);

  const now = new Date();
  let sent = 0, skipped = 0;
  const toNotify = [];

  for (const exam of exams) {
    const examDT = new Date(`${exam.date}T${exam.startTime}:00`);
    const minutesUntil = (examDT - now) / 60000;

    // Notify if within the window: e.g. between 55 and 65 mins before (5-min buffer either side)
    const windowMin = settings.notifyMinutes - 5;
    const windowMax = settings.notifyMinutes + 5;
    if (minutesUntil < windowMin || minutesUntil > windowMax) { skipped++; continue; }

    if (!exam.notifiedMain) {
      const invig = resolveInvigilator(exam.invigRaw);
      if (invig) toNotify.push({ exam, person: invig, role: 'Main Invigilator', type: 'main' });
    }
    if (!exam.notifiedBackup) {
      const backup = resolveInvigilator(exam.backupRaw);
      if (backup) toNotify.push({ exam, person: backup, role: 'Backup Invigilator', type: 'backup' });
    }
  }

  for (const item of toNotify) {
    const success = await sendEmail(item.exam, item.person, item.role, settings);
    if (success) {
      // Mark as notified
      const idx = exams.findIndex(e => e.id === item.exam.id);
      if (idx !== -1) {
        if (item.type === 'main') exams[idx].notifiedMain = true;
        else exams[idx].notifiedBackup = true;
      }
      sent++;
    }
  }

  S.set('exams', exams);
  renderDashboard();
  renderTimetable();
  renderLog();
  updateStats();

  const msg = toNotify.length === 0
    ? `✅ Check complete. No exams in the notification window right now (${settings.notifyMinutes} min before start). ${skipped} exams checked.`
    : `✅ Sent ${sent} of ${toNotify.length} notifications.`;
  setTestResult(msg, sent < toNotify.length && toNotify.length > 0 ? 'err' : 'ok');
}

async function sendEmail(exam, person, role, settings) {
  const email = resolveEmail(person);
  const firstName = person.name.split(' ')[0];
  const readinessTime = calcReadinessTime(exam.startTime, 20);
  const params = {
    to_name:        firstName,
    to_email:       email,
    exam_subject:   exam.syllabus,
    exam_component: exam.component,
    exam_date:      formatDate(exam.date),
    exam_time:      exam.startTime,
    exam_room:      exam.room || 'TBC',
    role:           role,
    readiness_time: readinessTime
  };

  try {
    await emailjs.send(settings.ejsServiceId, settings.ejsTemplateId, params);
    logNotification(exam, person, role, email, true);
    return true;
  } catch (err) {
    logNotification(exam, person, role, email, false, err.text || err.message);
    return false;
  }
}

async function manualNotify(examId) {
  const exam = exams.find(e => e.id === examId);
  if (!exam) return;
  const settings = getSettings();

  if (!settings.ejsPublicKey || !settings.ejsServiceId || !settings.ejsTemplateId) {
    showToast('EmailJS not configured. Go to Settings.', 'error');
    return;
  }

  emailjs.init(settings.ejsPublicKey);
  let sent = 0;

  const invig = resolveInvigilator(exam.invigRaw);
  if (invig) {
    const ok = await sendEmail(exam, invig, 'Main Invigilator', settings);
    if (ok) { exam.notifiedMain = true; sent++; }
  }
  const backup = resolveInvigilator(exam.backupRaw);
  if (backup) {
    const ok = await sendEmail(exam, backup, 'Backup Invigilator', settings);
    if (ok) { exam.notifiedBackup = true; sent++; }
  }

  S.set('exams', exams);
  renderDashboard();
  renderTimetable();
  renderLog();
  showToast(`${sent} notification(s) sent`, sent > 0 ? 'success' : 'error');
}

// ─── NOTIFICATION LOG ───────────────────────────────────────────
function logNotification(exam, person, role, email, success, errMsg) {
  notifLog.unshift({
    ts: new Date().toISOString(),
    examDate: exam.date,
    examTime: exam.startTime,
    subject: exam.syllabus,
    name: person.name,
    email,
    role,
    success,
    error: errMsg || null
  });
  // Keep last 500 entries
  if (notifLog.length > 500) notifLog = notifLog.slice(0, 500);
  S.set('notifLog', notifLog);
  renderLog();
  updateStats();
}

function renderLog() {
  const container = document.getElementById('logContainer');
  if (!notifLog.length) {
    container.innerHTML = '<p class="empty-state padded">No notifications sent yet.</p>';
    return;
  }
  container.innerHTML = notifLog.map(entry => `
    <div class="log-entry">
      <div class="log-time">${formatTs(entry.ts)}</div>
      <div>
        <strong>${entry.name}</strong> (${entry.role})<br/>
        <span style="color:var(--text-2);font-size:12px">${entry.subject} · ${formatDate(entry.examDate)} ${entry.examTime} · ${entry.email}</span>
        ${entry.error ? `<br/><span style="color:var(--accent);font-size:11px">Error: ${entry.error}</span>` : ''}
      </div>
      <div class="${entry.success ? 'log-ok' : 'log-fail'}">${entry.success ? '✓ Sent' : '✗ Failed'}</div>
    </div>`).join('');
}

function clearLog() {
  if (!confirm('Clear all notification logs?')) return;
  notifLog = [];
  S.set('notifLog', notifLog);
  renderLog();
  showToast('Log cleared');
}

// ─── SETTINGS UI ────────────────────────────────────────────────
function loadSettingsUI() {
  const s = getSettings();
  setVal('sheetsUrl', s.sheetsUrl || '');
  setVal('sheetsGid', s.sheetsGid || '1559134635');
  setVal('ejsPublicKey', s.ejsPublicKey || '');
  setVal('ejsServiceId', s.ejsServiceId || '');
  setVal('ejsTemplateId', s.ejsTemplateId || '');
  setVal('notifyMinutes', s.notifyMinutes || 60);
  setVal('emailDomain', s.emailDomain || 'regent.edu.pl');
  setVal('timezone', s.timezone || 'Europe/Warsaw');
}

async function testSheetConnection() {
  const url = getVal('sheetsUrl');
  if (!url) { showToast('Paste your CSV URL first', 'error'); return; }

  const el = document.getElementById('connectionTestResult');
  el.className = 'test-result info';
  el.textContent = '⏳ Testing connection — trying proxies…';
  el.classList.remove('hidden');

  const proxyNames = ['corsproxy.io', 'codetabs.com', 'allorigins.win', 'thingproxy'];
  let tried = 0;

  for (const proxyFn of CORS_PROXIES) {
    const proxyUrl = proxyFn(url);
    const name = proxyNames[tried++];
    el.textContent = `⏳ Trying proxy ${tried}/4: ${name}…`;
    try {
      const res = await Promise.race([
        fetch(proxyUrl),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout after 8s')), 8000))
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      let csv = text;
      try { const j = JSON.parse(text); if (j.contents) csv = j.contents; } catch {}
      const rowCount = csv.split('
').filter(r => r.trim()).length;
      el.className = 'test-result ok';
      el.innerHTML = `✅ <strong>Connection successful via ${name}!</strong><br/>
        Received ${rowCount} rows of data. Your URL is working correctly.<br/>
        Now click "Sync Now" to load the timetable.`;
      return;
    } catch (err) {
      el.textContent = `⏳ ${name} failed (${err.message}), trying next…`;
    }
  }
  el.className = 'test-result err';
  el.innerHTML = `❌ <strong>All 4 proxies failed.</strong><br/>
    This usually means the sheet URL is not publicly accessible.<br/>
    Please check: (1) the sheet is published as CSV, (2) the URL is copied correctly, (3) your internet connection is working.`;
}

function saveSheetSettings() {
  const s = getSettings();
  s.sheetsUrl = getVal('sheetsUrl');
  s.sheetsGid = getVal('sheetsGid');
  S.set('settings', s);
  showToast('Sheet settings saved', 'success');
}

function saveEmailSettings() {
  const s = getSettings();
  s.ejsPublicKey   = getVal('ejsPublicKey');
  s.ejsServiceId   = getVal('ejsServiceId');
  s.ejsTemplateId  = getVal('ejsTemplateId');
  S.set('settings', s);
  showToast('Email settings saved', 'success');
}

function saveNotificationSettings() {
  const s = getSettings();
  s.notifyMinutes = parseInt(getVal('notifyMinutes')) || 60;
  s.emailDomain   = getVal('emailDomain');
  s.timezone      = getVal('timezone');
  S.set('settings', s);
  // Re-generate emails for invigilators that use auto-email
  renderInvigilators();
  showToast('Notification settings saved', 'success');
}

function changePin() {
  const s = getSettings();
  const current = document.getElementById('currentPin').value;
  const newPin   = document.getElementById('newPin').value;
  const confirm  = document.getElementById('confirmPin').value;
  if (current !== s.pin)       { showToast('Current PIN is incorrect', 'error'); return; }
  if (newPin.length < 4)       { showToast('New PIN must be at least 4 digits', 'error'); return; }
  if (newPin !== confirm)      { showToast('PINs do not match', 'error'); return; }
  s.pin = newPin;
  S.set('settings', s);
  document.getElementById('currentPin').value = '';
  document.getElementById('newPin').value = '';
  document.getElementById('confirmPin').value = '';
  showToast('PIN changed successfully', 'success');
}

async function sendTestEmail() {
  const settings = getSettings();
  if (!settings.ejsPublicKey || !settings.ejsServiceId || !settings.ejsTemplateId) {
    showToast('Configure EmailJS settings first', 'error');
    return;
  }
  emailjs.init(settings.ejsPublicKey);
  const params = {
    to_name: 'Test',
    to_email: 'test@example.com',
    exam_subject: 'TEST — Mathematics',
    exam_component: 'Pure Mathematics 1',
    exam_date: formatDate(getTodayStr()),
    exam_time: '10:00',
    exam_room: '5d',
    role: 'Main Invigilator',
    readiness_time: '09:40'
  };
  try {
    await emailjs.send(settings.ejsServiceId, settings.ejsTemplateId, params);
    showToast('Test email sent!', 'success');
  } catch (err) {
    showToast('Test failed: ' + (err.text || err.message), 'error');
  }
}

// ─── STATS ──────────────────────────────────────────────────────
function updateStats() {
  const today = getTodayStr();
  const todayExams = exams.filter(e => e.date === today);
  const sentToday = notifLog.filter(l => l.ts.startsWith(today) && l.success).length;
  const activeInvig = invigilators.filter(i => i.active).length;

  document.getElementById('statToday').textContent = todayExams.length;
  document.getElementById('statSentToday').textContent = sentToday;
  document.getElementById('statInvigilators').textContent = activeInvig;
  document.getElementById('statTotal').textContent = exams.length;
}

// ─── SYNC STATUS ────────────────────────────────────────────────
function showSyncStatus(msg, type) {
  const el = document.getElementById('syncStatus');
  el.textContent = msg;
  el.className = `sync-status ${type}`;
  el.classList.remove('hidden');
}

function setTestResult(msg, type) {
  const el = document.getElementById('testResult');
  el.textContent = msg;
  el.className = `test-result ${type}`;
  el.classList.remove('hidden');
}

// ─── TOAST ──────────────────────────────────────────────────────
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  if (!t) { console.log('Toast:', msg); return; }
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3200);
}

// ─── DATE/TIME HELPERS ──────────────────────────────────────────
function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return dateStr; }
}

function formatTs(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  } catch { return ts; }
}

function calcReadinessTime(startTime, minsBefore) {
  const [h, m] = startTime.split(':').map(Number);
  const total = h * 60 + m - minsBefore;
  const rh = Math.floor(total / 60).toString().padStart(2, '0');
  const rm = (total % 60).toString().padStart(2, '0');
  return `${rh}:${rm}`;
}

// ─── UTILITY ────────────────────────────────────────────────────
function getVal(id) { return document.getElementById(id)?.value || ''; }
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
