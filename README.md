# 🎓 Regent Exam Notifier

Automated email notification system for exam invigilators at Regent.
Sends emails **1 hour before each exam** to both the main and backup invigilator.

Live timetable is read directly from your Google Sheet — no manual uploads needed.

---

## 🗂 Project Structure

```
exam-notifier/
├── index.html              ← Admin dashboard (hosted on GitHub Pages)
├── src/
│   ├── app.js              ← Dashboard JS logic
│   └── style.css           ← Styles
├── scripts/
│   ├── notify.js           ← Node.js notification engine (run by GitHub Actions)
│   └── package.json
├── data/
│   └── sent-log.json       ← Tracks which notifications have been sent (auto-updated)
└── .github/workflows/
    └── notify.yml          ← GitHub Actions cron schedule
```

---

## 🚀 Setup Guide (Step-by-Step)

### Step 1 — Fork / Push to GitHub

1. Create a new GitHub repository (e.g. `regent-exam-notifier`)
2. Push all these files to it
3. Go to **Settings → Pages** and set the source to `main` branch / `root` folder
4. Your dashboard will be live at `https://yourusername.github.io/regent-exam-notifier/`

---

### Step 2 — Publish Your Google Sheet as CSV

1. Open your Google Sheet
2. Go to **File → Share → Publish to web**
3. Under "Link", select the tab **"Wygenerowania - chronologicznie"**
4. Change format to **CSV**
5. Click **Publish** and copy the URL

The URL looks like:
```
https://docs.google.com/spreadsheets/d/1tmse7T72uVAC8S0ONDA8MdM75AXLFDFECtnzK_1qBjo/pub?gid=1559134635&single=true&output=csv
```

---

### Step 3 — Set Up EmailJS (Free)

1. Go to [https://emailjs.com](https://emailjs.com) and create a free account
2. **Add Email Service**: Connect Gmail (or any SMTP)
3. **Create Email Template** with this exact content:

**Subject:**
```
⏰ Exam Reminder: {{exam_subject}} — Today at {{exam_time}}
```

**Body:**
```
Dear {{to_name}},

This is your reminder that you are scheduled as **{{role}}** for the following exam:

Subject:    {{exam_subject}}
Paper:      {{exam_component}}
Date:       {{exam_date}}
Start Time: {{exam_time}}
Room:       {{exam_room}}

Please be ready and in the room by {{readiness_time}} (20 minutes before start).

If you have any questions, please contact the Exams Office immediately.

Best regards,
Regent Exams Office
```

4. Note down your:
   - **Public Key** (Account → API Keys)
   - **Service ID** (Email Services)
   - **Template ID** (Email Templates)

---

### Step 4 — Add GitHub Secrets

Go to your repo → **Settings → Secrets and variables → Actions**

Add these **Secrets** (sensitive):
| Secret Name | Value |
|---|---|
| `SHEETS_URL` | The CSV URL from Step 2 |
| `EJS_PUBLIC_KEY` | Your EmailJS Public Key |
| `EJS_SERVICE_ID` | Your EmailJS Service ID |
| `EJS_TEMPLATE_ID` | Your EmailJS Template ID |

Add these **Variables** (non-sensitive):
| Variable Name | Value |
|---|---|
| `NOTIFY_MINUTES` | `60` |
| `EMAIL_DOMAIN` | `regent.edu.pl` |
| `TIMEZONE` | `Europe/Warsaw` |

---

### Step 5 — Configure the Admin Dashboard

1. Visit your GitHub Pages URL
2. Log in with the default PIN: **1234** (change it in Settings immediately)
3. Go to **Settings → Google Sheets** and paste the CSV URL
4. Go to **Settings → EmailJS Config** and fill in your keys
5. Click **🔄 Sync from Google Sheets** on the Dashboard to load the timetable
6. You should see all your exams listed

---

### Step 6 — Verify GitHub Actions

1. Go to your repo → **Actions** tab
2. Click **Exam Notification Checker** → **Run workflow** to test it manually
3. Check the logs — you should see it fetch the sheet and report any due notifications

The workflow runs **every 15 minutes** automatically during school hours (Mon–Sat, 07:00–19:00 Warsaw time).

---

## 🔄 Using for a New Exam Period

When a new exam period starts:
1. Update your Google Sheet with the new timetable
2. The system will automatically pick up the new exams next time it syncs
3. The `data/sent-log.json` file will be automatically pruned of old entries (90-day retention)
4. No other changes needed

---

## 📧 Invigilator Email Addresses

Emails are auto-generated as `firstname.surname@regent.edu.pl`.

You can override any address in the **Invigilators** tab of the dashboard.

---

## 🛡 Security Notes

- The admin dashboard is PIN-protected (client-side)
- All secrets (EmailJS keys, Sheet URL) are stored in GitHub Secrets — never in the code
- The sent-log prevents duplicate notifications even if the action runs multiple times

---

## 🐛 Troubleshooting

| Problem | Solution |
|---|---|
| Sheet not loading | Make sure the sheet is published to the web as CSV (File → Share → Publish to web) |
| Emails not sending | Check EmailJS keys in Settings; verify the template variable names match exactly |
| Duplicate notifications | Check `data/sent-log.json` — it prevents double-sends |
| Wrong notification time | Check `NOTIFY_MINUTES` variable in GitHub Actions settings |
| Actions not running | Free GitHub accounts have Actions limits; check the Actions tab for errors |
