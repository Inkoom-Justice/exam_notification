# 🎓 Regent Exam Notifier v2

Production-ready exam invigilation notification system.
Firebase-backed · Multi-invigilator · Archive system · PDF compile · Warsaw timezone.

---

## What's new in v2

| Feature | Detail |
|---|---|
| **Firebase persistence** | All data stored in Firestore — available on any device instantly |
| **Timetable archive** | Save any timetable permanently; browse & restore historical records |
| **Compile PDF** | Generate per-invigilator schedule PDFs and email them automatically |
| **Multi-invigilator** | Semicolon/comma-separated names all notified individually |
| **CSV parsing fixed** | Handles duplicate "Exam Date" columns and quoted commas correctly |
| **Entries field** | Number of students read from sheet and included in all emails |

---

## Project Structure

```
regent-notifier/
├── index.html                   ← Admin dashboard (GitHub Pages)
├── src/
│   ├── app.js                   ← Full dashboard logic (ES module)
│   ├── firebase-config.js       ← Your Firebase credentials (fill in)
│   ├── firebase-service.js      ← All Firestore operations
│   └── shared.css               ← Styles
├── scripts/
│   ├── notify.js                ← GitHub Actions notification engine
│   └── package.json
├── data/
│   └── sent-log.json            ← Duplicate-prevention log (auto-committed)
└── .github/workflows/
    └── notify.yml               ← Cron: daily at 19:00 Warsaw
```

---

## Setup Guide

### Step 1 — Firebase

1. Go to https://console.firebase.google.com
2. Create project → name it `regent-exam-notifier`
3. **Firestore Database** → Create database → Production mode → `europe-west` region
4. **Authentication** → Get Started → Enable **Anonymous** sign-in
5. **Project Settings** → Your apps → `</>` Web → Register → copy config values
6. Paste values into `src/firebase-config.js`
7. **Firestore → Rules** → paste these rules and Publish:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

### Step 2 — Google Sheet

1. Open your timetable sheet → **File → Share → Publish to web**
2. Select the `Wygenerowania - chronologicznie` tab → **CSV** → Publish
3. Copy the `/pub?gid=…&output=csv` URL

### Step 3 — EmailJS

1. Sign up at https://emailjs.com (free)
2. Add Email Service (Gmail recommended)
3. Create Email Template with these variables:

| Variable | Value |
|---|---|
| `{{to_name}}` | First name |
| `{{to_email}}` | Recipient email |
| `{{exam_subject}}` | Subject name |
| `{{exam_component}}` | Paper name |
| `{{exam_date}}` | Formatted date |
| `{{exam_time}}` | Start time |
| `{{finish_time}}` | Normal end time |
| `{{ext_finish}}` | Extended end (or N/A) |
| `{{exam_room}}` | Room |
| `{{num_entries}}` | Number of students |
| `{{role}}` | Main or Backup Invigilator |
| `{{readiness_time}}` | 20 min before start |

### Step 4 — GitHub

1. Push all files to your GitHub repo
2. **Settings → Pages** → Source: `main` branch / root
3. **Settings → Secrets → Actions** → add:
   - `SHEETS_URL` — your published CSV URL
   - `EJS_PUBLIC_KEY` — EmailJS public key
   - `EJS_SERVICE_ID` — EmailJS service ID
   - `EJS_TEMPLATE_ID` — EmailJS template ID
4. **Settings → Actions → General → Workflow permissions** → Read and write permissions

### Step 5 — First run

1. Visit your GitHub Pages URL
2. Log in (default PIN: **1234**)
3. Go to **Settings** → fill in Google Sheets URL and EmailJS keys → Save
4. Dashboard → **🔄 Sync Google Sheets**
5. You should see all exams listed with correct dates and statuses

---

## How notifications work

**Two layers — notifications always go out:**

1. **Browser engine** — when you're logged into the dashboard, a 60-second loop checks if any exam starts in ~60 minutes and sends automatically
2. **GitHub Actions** — runs daily at 19:00 Warsaw time, sends for all of tomorrow's exams regardless of whether anyone is logged in

Both layers use the same sent-log to prevent duplicates.

---

## Timetable Archive

- Click **💾 Save Timetable** (dashboard or timetable tab) to archive
- Browse all archives in the **Saved Timetables** tab
- Click **View** to see the full exam list from any archive
- Click **Restore** to make an archived timetable the active one
- Archives are stored permanently in Firebase — no limit

---

## Compile Feature

In the **Invigilators** tab, click 📋 next to any invigilator to:
- See their complete invigilation schedule in a modal
- Click **Generate & Email PDF** to:
  - Download a professionally formatted A4 landscape PDF
  - Automatically email it to the invigilator via EmailJS

---

## Multi-invigilator support

If your sheet has multiple names in the invigilator columns, separate them with semicolons:

```
Anna Martowicz; Roger Messer; Marta Szweda
```

The system will send individual emails to each person, logged separately.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| 0 exams loaded | Check sheet tab GID in the published URL matches the timetable tab |
| Firebase offline | Check `src/firebase-config.js` has real values (not placeholders) |
| Emails not sending | Test via Settings → Send Test Email; verify all 3 EmailJS IDs |
| PIN not working | Default is `1234`; if changed, use the new PIN |
| GitHub Actions 403 | Settings → Actions → General → set Read and write permissions |
| Actions 401 on sheet | Sheet must be set to "Anyone with link" and published as CSV |
