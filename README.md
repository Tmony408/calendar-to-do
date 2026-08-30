# Tmony

Tmony is a multi-user task planner with Google Calendar sync and an AI-assisted progress journal.

## Progress Journal

Open **My Journal** in the sidebar to create a journal for today, this week, month, year, or a custom date range. Tmony calculates achievements, categories, streaks, recurring wins, completed subtasks, and recovered overdue tasks from recorded activity. Add a personal reflection, generate a narrative, edit it, save it, and download it as PDF or Markdown.

The Journal screen also includes a weekly review schedule. After connecting Google Calendar, enable it to create two recurring Calendar events with popup notifications. It defaults to Sunday at 7:00 AM and 7:00 PM, and each user can change the day or either time. Turning it off removes both Calendar events.

Journal claims are grounded in verified task data. If `GROQ_API_KEY` is configured, Tmony uses Groq structured output; otherwise it automatically creates a local facts-only edition. Identical journals are cached, and each user is limited to three new Groq generations per day.

For AI journals, create a key in the Groq console and set:

```env
GROQ_API_KEY=your-key
GROQ_DAILY_MODEL=openai/gpt-oss-20b
GROQ_LONG_MODEL=openai/gpt-oss-120b
```

Keep this key server-side. Never add it to `public/` or commit a real value.

A personalized, responsive todo workspace with email/password authentication, Google sign-in, priorities, categories, subtasks, recurring tasks, reminders, dark mode, dashboard statistics, and two-way Google Calendar updates.

## Try it locally

### Fastest option: Docker Desktop

```bash
docker compose up --build
```

Open `http://localhost:3000` and choose **Preview with demo tasks**. Stop it with `Ctrl+C`; the local PostgreSQL data remains in the Docker volume.

### Node.js option

Prerequisites: Node.js 20+ and PostgreSQL.

```bash
cp .env.example .env
# Edit DATABASE_URL, then create the database.
npm install
npm run db:migrate
npm run dev
```

Open `http://localhost:3000` and choose **Preview with demo tasks**. `DEMO_MODE=true` enables the preview; never enable it on a public production service.

Run the automated checks with `npm test`.

## Configure Google

1. Create a project in Google Cloud Console and enable **Google Calendar API**.
2. Configure the OAuth consent screen. While the app is in testing, add each allowed Google account as a test user.
3. Create an OAuth 2.0 **Web application** client.
4. Add these authorized redirect URIs (replace the production hostname):
   - `http://localhost:3000/api/google/login/callback`
   - `http://localhost:3000/api/google/calendar/callback`
   - `https://YOUR-APP.onrender.com/api/google/login/callback`
   - `https://YOUR-APP.onrender.com/api/google/calendar/callback`
5. Put the client ID and secret in `.env` locally and in Render environment variables.

Calendar access is requested separately from sign-in. Dated tasks create tagged events in the user's primary calendar. Only events created by this app are processed on inbound sync, so unrelated calendar appointments remain untouched. Editing an app event's title, time, description, completion marker, or deleting it updates its task. Google Calendar delivers the actual popup notifications according to each event's reminder setting.

Push notifications require a public HTTPS `APP_URL`, so instant inbound sync becomes active after deployment. Local testing still covers outbound event creation; production also runs incremental reconciliation and renews expiring notification channels.

## Deploy on Render

The repository includes `render.yaml`. In Render, choose **New → Blueprint**, connect this GitHub repository, and deploy it. Supply:

- `APP_URL`: the final `https://...onrender.com` URL
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GROQ_API_KEY` (optional; without it, journals use the local facts-only writer)

Render generates the JWT and token-encryption secrets and links PostgreSQL automatically. After the first deploy, set the exact Render URL as `APP_URL`, add its callback URLs in Google Cloud, then redeploy.

> Render's free PostgreSQL database currently expires after 30 days. Choose a persistent paid database for long-term personal data.

## Security notes

- Passwords use bcrypt with cost 12.
- Login sessions are HTTP-only, same-site cookies.
- Google refresh tokens use AES-256-GCM encryption at rest.
- OAuth state values are single-use and expire after ten minutes.
- Calendar webhooks are matched to random channel IDs stored per user.
- Do not commit `.env` or any Google credentials.
