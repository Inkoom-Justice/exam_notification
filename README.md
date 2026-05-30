# 🎓 Regent Exam Notifier

Automated exam invigilation notification system.
Sends emails to ALL assigned invigilators before each exam.

---

## Repo structure

```
regent-exam-notifier/
├── index.html                        ← Admin dashboard (served by GitHub Pages)
├── .gitignore
├── README.md
│
├── src/
│   ├── app.js                        ← All dashboard logic
│   ├── shared.css                    ← Styles
│   ├── firebase-config.js            ← YOUR Firebase credentials (fill in)
│   └── firebase-service.js           ← Firestore read/write layer
│
├── scripts/
│   ├── notify.js                     ← GitHub Actions notification engine
│   └── package.json
│
├── data/
│   └── sent-log.json                 ← Auto-updated by Actions (prevents duplicates)
│
└── .github/
    └── workflows/
        └── notify.yml                ← Cron schedule (daily 19:00 Warsaw)
```

---

# GO-LIVE GUIDE

Follow these steps in order. Each one takes 2–10 minutes.

---

## STEP 1 — Firebase (database + auth)

You did this already. Your `src/firebase-config.js` should already have real values.

**Checklist — confirm all four are done:**
- [ ] Firestore Database created (europe-west region, production mode)
- [ ] Firestore Security Rules set to allow authenticated reads/writes (see rules below)
- [ ] Anonymous Authentication enabled
- [ ] `src/firebase-config.js` filled in with your project's real values

**Firestore Rules** (Firebase Console → Firestore → Rules tab → Publish):
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

---

## STEP 2 — Google Sheet

1. Open your Google Sheet copy
2. Click **Share** (top right) → change to **"Anyone with the link"** → Viewer → Done
3. **File → Share → Publish to web**
4. Under "Link" dropdown, select the tab: **Wygenerowania - chronologicznie**
5. Change format dropdown to **CSV**
6. Click **Publish** → confirm → **copy the URL**

The URL looks like:
```
https://docs.google.com/spreadsheets/d/e/2PACX-…/pub?gid=1559134635&single=true&output=csv
```

Keep this URL — you will paste it into the dashboard Settings after going live.

---

## STEP 3 — EmailJS

1. Go to **https://emailjs.com** → sign up free
2. **Email Services** → Add New Service → choose Gmail → connect your Gmail account → **Create Service**
   - Note your **Service ID** (e.g. `service_abc123`)
3. **Email Templates** → Create New Template
   - Use this subject: `⏰ Exam Reminder: {{exam_subject}} — {{exam_date}} at {{exam_time}}`
   - Use this body:

```
Dear {{to_name}},

This is your invigilation reminder.

Subject:     {{exam_subject}}
Paper:       {{exam_component}}
Date:        {{exam_date}}
Start Time:  {{exam_time}}
Room:        {{exam_room}}
Students:    {{num_entries}}
Your Role:   {{role}}

Please be ready in the room by {{readiness_time}} (20 minutes before start).
Normal finish: {{finish_time}}
Extended finish: {{ext_finish}}

Regent Exams Office
```

   - Click **Save**
   - Note your **Template ID** (e.g. `template_xyz789`)

4. **Account → API Keys** → copy your **Public Key** (e.g. `user_AbCdEf123`)

---

## STEP 4 — Push to GitHub

### 4a. Create the repository

1. Go to **https://github.com** → click **+** → **New repository**
2. Name it: `regent-exam-notifier`
3. Set to **Public** (required for free GitHub Pages)
4. Do NOT initialise with README
5. Click **Create repository**

### 4b. Push these files

Open a terminal in this folder and run:

```bash
git init
git add .
git commit -m "Initial commit — Regent Exam Notifier"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/regent-exam-notifier.git
git push -u origin main
```

Replace `YOUR-USERNAME` with your actual GitHub username.

---

## STEP 5 — GitHub Pages (host the dashboard)

1. In your repo → **Settings** tab
2. Left sidebar → **Pages**
3. Under "Source" → select **Deploy from a branch**
4. Branch: **main** / Folder: **/ (root)**
5. Click **Save**
6. Wait ~60 seconds → refresh the page
7. You will see: *"Your site is live at https://YOUR-USERNAME.github.io/regent-exam-notifier/"*

That URL is your admin dashboard. Bookmark it.

---

## STEP 6 — GitHub Secrets (for Actions)

1. In your repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret** and add each one:

| Secret name | Value |
|---|---|
| `SHEETS_URL` | The CSV URL from Step 2 |
| `EJS_PUBLIC_KEY` | Your EmailJS Public Key from Step 3 |
| `EJS_SERVICE_ID` | Your EmailJS Service ID from Step 3 |
| `EJS_TEMPLATE_ID` | Your EmailJS Template ID from Step 3 |

3. Still in **Settings → Actions → General**
4. Scroll to **Workflow permissions**
5. Select **Read and write permissions** → Save

---

## STEP 7 — First login and sync

1. Visit your GitHub Pages URL
2. Enter PIN: **1234** → Unlock Dashboard
3. Go to **Settings** tab
4. Under **Google Sheets**: paste your CSV URL → click **💾 Save** → click **🔄 Sync Now**
5. Under **EmailJS Config**: paste your Public Key, Service ID, Template ID → click **💾 Save**
6. Click **📧 Send Test Email** — check it arrives in your EmailJS dashboard logs
7. Go back to **Dashboard** — you should see your exams listed

---

## STEP 8 — Test GitHub Actions

1. Repo → **Actions** tab
2. Click **Autonomous Evening Exam Notifier** in the left list
3. Click **Run workflow** → **Run workflow** (green button)
4. Click the running job to watch the logs
5. You should see it fetch the sheet, parse exams, and report how many notifications it sent

If you see errors, check the troubleshooting section below.

---

## HOW THE SYSTEM WORKS

### Two notification layers

| Layer | When | How |
|---|---|---|
| **GitHub Actions** | Daily 19:00 Warsaw | Sends emails for **tomorrow's** exams. Runs even when you are offline. |
| **Browser engine** | Every 60s while logged in | Sends emails for **today's** exams when the time window arrives. |

Both layers use the same sent-log to prevent duplicates.

### Saving and archiving timetables

- Click **💾 Save Timetable** (Dashboard or Timetable tab) to archive the current timetable
- Go to **🗄 Saved Timetables** tab to browse all archives
- Click **👁 View** to see the full exam list from any archive
- Click **↩ Restore** to make an old timetable the active one again
- Archives are stored permanently in localStorage (and Firebase if configured)

### Compiling invigilator schedules

- Go to **👥 Invigilators** tab
- Click **📋** next to any invigilator
- A modal shows their complete schedule for the entire exam period
- Click **⬇ Download PDF** to save an A4 landscape PDF of their schedule
- Click **📧 Email PDF** to send it to their email address automatically

### Multiple invigilators per exam

If your sheet has semicolon-separated names in the invigilator column:
```
Anna Martowicz; Roger Messer; Marta Szweda
```
Every person receives their own individual email.

---

## TROUBLESHOOTING

| Problem | Solution |
|---|---|
| Dashboard shows blank / no CSS | Check GitHub Pages is set to root folder, not /docs |
| "0 exams loaded" after sync | Check the CSV URL includes the correct `gid=` for the timetable tab |
| Fetch failed: HTTP 401 | Sheet is not public — redo Step 2 (Share → Anyone with link) |
| Fetch failed: returned HTML | Sheet requires login — republish as CSV after making it public |
| Emails not sending | Settings → Send Test Email → check EmailJS dashboard for errors |
| GitHub Actions 403 on push | Settings → Actions → General → Read and write permissions |
| GitHub Actions HTTP 401 | Check SHEETS_URL secret is set correctly in repo secrets |
| PIN not working | Default is `1234` — if you changed it and forgot it, clear localStorage in browser DevTools |
| Firebase "permission denied" | Check Firestore Rules are published (Step 1 checklist) |
| Firebase not connecting | Check `src/firebase-config.js` has real values, not the placeholder "YOUR_API_KEY" text |
