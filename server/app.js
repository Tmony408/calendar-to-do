import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import { pool } from './store.js';
import { randomId, safeUser, signSession, verifySession } from './security.js';
import { deleteCalendarEvent, exchangeCode, googleAuthUrl, googleProfile, handleWebhook, saveCalendarConnection, syncJournalReminder, syncTaskToCalendar } from './calendar.js';
import { generateJournal, getJournalFacts, journalMarkdown, journalPdf, recordTaskEvent } from './journal.js';

const app = express();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 };
const oauthCookieOptions = { ...cookieOptions, maxAge: 10 * 60 * 1000 };
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function auth(req, res, next) {
  if (process.env.DEMO_MODE === 'true' && req.headers['x-demo-user'] === 'demo') {
    req.user = { id: '00000000-0000-4000-8000-000000000001', email: 'demo@tmony.app' }; return next();
  }
  try { req.user = verifySession(req.cookies.session); next(); }
  catch { res.status(401).json({ error: 'Please sign in to continue' }); }
}

function validateTask(input, partial = false) {
  const output = {};
  if (!partial || input.title !== undefined) {
    output.title = String(input.title || '').trim(); if (!output.title || output.title.length > 180) throw Object.assign(new Error('Title must be 1–180 characters'), { status: 400 });
  }
  if (input.notes !== undefined) output.notes = String(input.notes).slice(0, 5000);
  if (input.priority !== undefined) { if (!['low','medium','high'].includes(input.priority)) throw Object.assign(new Error('Invalid priority'), { status: 400 }); output.priority = input.priority; }
  if (input.recurrence !== undefined) { if (!['none','daily','weekly','monthly'].includes(input.recurrence)) throw Object.assign(new Error('Invalid recurrence'), { status: 400 }); output.recurrence = input.recurrence; }
  if (input.dueAt !== undefined) { if (input.dueAt && Number.isNaN(Date.parse(input.dueAt))) throw Object.assign(new Error('Invalid due date'), { status: 400 }); output.due_at = input.dueAt || null; }
  if (input.completed !== undefined) output.completed = Boolean(input.completed);
  if (input.categoryId !== undefined) output.category_id = input.categoryId || null;
  if (input.reminderMinutes !== undefined) { const value = Number(input.reminderMinutes); if (!Number.isInteger(value) || value < 0 || value > 40320) throw Object.assign(new Error('Reminder must be between 0 and 40320 minutes'), { status: 400 }); output.reminder_minutes = value; }
  return output;
}

async function ensureDemo() {
  if (process.env.DEMO_MODE !== 'true') return;
  const id = '00000000-0000-4000-8000-000000000001';
  await pool.query("INSERT INTO users(id,name,email) VALUES($1,'Testimony','demo@tmony.app') ON CONFLICT DO NOTHING", [id]);
  const { rows } = await pool.query('SELECT COUNT(*)::int count FROM tasks WHERE user_id=$1', [id]);
  if (!rows[0].count) {
    const category = randomId();
    await pool.query("INSERT INTO categories(id,user_id,name,color) VALUES($1,$2,'Personal','#7c5cff')", [category, id]);
    await pool.query(`INSERT INTO tasks(id,user_id,category_id,title,notes,priority,due_at,sync_status) VALUES
      ($1,$2,$3,'Plan my productive week','Break the week into three achievable goals.','high',NOW()+INTERVAL '1 day','local'),
      ($4,$2,$3,'Connect Google Calendar','Enable two-way sync when Google credentials are ready.','medium',NOW()+INTERVAL '2 days','local')`, [randomId(), id, category, randomId()]);
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.post('/api/demo/start', asyncRoute(async (_req, res) => { if (process.env.DEMO_MODE !== 'true') return res.status(404).end(); await ensureDemo(); res.json({ user: { id: 'demo', name: 'Testimony', email: 'demo@tmony.app', timezone: 'Africa/Lagos' } }); }));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim(); const email = String(req.body.email || '').trim().toLowerCase(); const password = String(req.body.password || '');
  if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return res.status(400).json({ error: 'Use a valid name, email, and password of at least 8 characters' });
  const user = { id: randomId(), name, email };
  try { await pool.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)', [user.id, name, email, await bcrypt.hash(password, 12)]); }
  catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'An account already exists for this email' }); throw error; }
  res.cookie('session', signSession(user), cookieOptions).status(201).json({ user });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email]); const user = rows[0];
  if (!user?.password_hash || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) return res.status(401).json({ error: 'Incorrect email or password' });
  res.cookie('session', signSession(user), cookieOptions).json({ user: safeUser(user) });
}));
app.post('/api/auth/logout', (_req, res) => res.clearCookie('session', cookieOptions).status(204).end());
app.get('/api/auth/me', auth, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`SELECT u.*, EXISTS(SELECT 1 FROM calendar_connections c WHERE c.user_id=u.id) calendar_connected FROM users u WHERE u.id=$1`, [req.user.id]);
  res.json({ user: { ...safeUser(rows[0]), calendarConnected: rows[0].calendar_connected } });
}));

app.get('/api/google/login/start', asyncRoute(async (_req, res) => {
  const state = randomId(); await pool.query("INSERT INTO oauth_states(state,purpose,expires_at) VALUES($1,'login',NOW()+INTERVAL '10 minutes')", [state]); res.cookie('oauth_state', state, oauthCookieOptions).redirect(googleAuthUrl({ state, purpose: 'login' }));
}));
app.get('/api/google/login/callback', asyncRoute(async (req, res) => {
  if (!req.cookies.oauth_state || req.cookies.oauth_state !== req.query.state) return res.status(400).send('Google sign-in was not started in this browser.');
  const { rows } = await pool.query("DELETE FROM oauth_states WHERE state=$1 AND purpose='login' AND expires_at>NOW() RETURNING state", [req.query.state]); if (!rows[0]) return res.status(400).send('Invalid or expired Google sign-in request.');
  const tokens = await exchangeCode(req.query.code, 'login'); const profile = await googleProfile(tokens.access_token);
  if (!profile.email_verified) return res.status(403).send('Your Google email address must be verified.');
  const id = randomId(); const result = await pool.query(`INSERT INTO users(id,name,email,google_sub,avatar_url) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(email) DO UPDATE SET google_sub=EXCLUDED.google_sub, avatar_url=EXCLUDED.avatar_url, updated_at=NOW() RETURNING *`, [id, profile.name, profile.email.toLowerCase(), profile.sub, profile.picture]);
  res.clearCookie('oauth_state', oauthCookieOptions).cookie('session', signSession(result.rows[0]), cookieOptions).redirect('/');
}));
app.get('/api/google/calendar/start', auth, asyncRoute(async (req, res) => {
  const state = randomId(); await pool.query("INSERT INTO oauth_states(state,user_id,purpose,expires_at) VALUES($1,$2,'calendar',NOW()+INTERVAL '10 minutes')", [state, req.user.id]); res.cookie('oauth_state', state, oauthCookieOptions).redirect(googleAuthUrl({ state, purpose: 'calendar' }));
}));
app.get('/api/google/calendar/callback', asyncRoute(async (req, res) => {
  if (!req.cookies.oauth_state || req.cookies.oauth_state !== req.query.state) return res.status(400).send('Calendar connection was not started in this browser.');
  const { rows } = await pool.query("DELETE FROM oauth_states WHERE state=$1 AND purpose='calendar' AND expires_at>NOW() RETURNING user_id", [req.query.state]); if (!rows[0]) return res.status(400).send('Invalid or expired Calendar connection request.');
  const tokens = await exchangeCode(req.query.code, 'calendar'); await saveCalendarConnection(rows[0].user_id, tokens.refresh_token); res.clearCookie('oauth_state', oauthCookieOptions).redirect('/?calendar=connected');
}));

app.get('/api/dashboard', auth, asyncRoute(async (req, res) => {
  const [tasks, categories] = await Promise.all([
    pool.query(`SELECT t.*, c.name category_name, c.color category_color,
      COALESCE(json_agg(json_build_object('id',s.id,'title',s.title,'completed',s.completed,'position',s.position) ORDER BY s.position) FILTER (WHERE s.id IS NOT NULL),'[]') subtasks
      FROM tasks t LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN subtasks s ON s.task_id=t.id WHERE t.user_id=$1 GROUP BY t.id,c.name,c.color ORDER BY t.completed, t.due_at NULLS LAST, t.created_at DESC`, [req.user.id]),
    pool.query('SELECT * FROM categories WHERE user_id=$1 ORDER BY name', [req.user.id]),
  ]);
  res.json({ tasks: tasks.rows, categories: categories.rows });
}));

app.post('/api/tasks', auth, asyncRoute(async (req, res) => {
  const task = validateTask(req.body); const id = randomId();
  const { rows } = await pool.query(`INSERT INTO tasks(id,user_id,title,notes,priority,due_at,recurrence,category_id,reminder_minutes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [id, req.user.id, task.title, task.notes || '', task.priority || 'medium', task.due_at || null, task.recurrence || 'none', task.category_id || null, task.reminder_minutes ?? 30]);
  await recordTaskEvent({ userId: req.user.id, taskId: id, eventType: 'task_created', title: rows[0].title, priority: rows[0].priority });
  res.status(201).json({ task: rows[0] }); void syncTaskToCalendar(rows[0]);
}));
app.patch('/api/tasks/:id', auth, asyncRoute(async (req, res) => {
  const changes = validateTask(req.body, true); const entries = Object.entries(changes); if (!entries.length) return res.status(400).json({ error: 'No valid changes supplied' });
  const beforeResult = await pool.query(`SELECT t.*,c.name category_name FROM tasks t LEFT JOIN categories c ON c.id=t.category_id WHERE t.id=$1 AND t.user_id=$2`, [req.params.id, req.user.id]);
  const before = beforeResult.rows[0]; if (!before) return res.status(404).json({ error: 'Task not found' });
  const sets = entries.map(([key], index) => `${key}=$${index + 3}`);
  if (changes.completed === true && !before.completed) sets.push('completed_at=NOW()');
  if (changes.completed === false && before.completed) sets.push('completed_at=NULL');
  const { rows } = await pool.query(`UPDATE tasks SET ${sets.join(',')}, sync_status='pending', updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`, [req.params.id, req.user.id, ...entries.map(([, value]) => value)]);
  const eventType = changes.completed === true && !before.completed ? 'task_completed' : changes.completed === false && before.completed ? 'task_reopened' : 'task_updated';
  await recordTaskEvent({ userId: req.user.id, taskId: before.id, eventType, title: rows[0].title, category: before.category_name, priority: rows[0].priority, metadata: { changed: Object.keys(changes) } });
  res.json({ task: rows[0] }); void syncTaskToCalendar(rows[0]);
}));
app.delete('/api/tasks/:id', auth, asyncRoute(async (req, res) => {
  const found = await pool.query(`SELECT t.*,c.name category_name FROM tasks t LEFT JOIN categories c ON c.id=t.category_id WHERE t.id=$1 AND t.user_id=$2`, [req.params.id, req.user.id]);
  if (!found.rows[0]) return res.status(404).json({ error: 'Task not found' }); const task = found.rows[0];
  await recordTaskEvent({ userId: req.user.id, taskId: task.id, eventType: 'task_deleted', title: task.title, category: task.category_name, priority: task.priority });
  await pool.query('DELETE FROM tasks WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]); res.status(204).end(); if (task.google_event_id) void deleteCalendarEvent(req.user.id, task.google_event_id);
}));
app.post('/api/tasks/:id/subtasks', auth, asyncRoute(async (req, res) => {
  const title = String(req.body.title || '').trim(); if (!title) return res.status(400).json({ error: 'Subtask title is required' });
  const { rows } = await pool.query(`INSERT INTO subtasks(id,task_id,title,position) SELECT $1,t.id,$2,COALESCE((SELECT MAX(position)+1 FROM subtasks WHERE task_id=t.id),0) FROM tasks t WHERE t.id=$3 AND t.user_id=$4 RETURNING *`, [randomId(), title, req.params.id, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
  const task = await pool.query('SELECT title,priority FROM tasks WHERE id=$1', [req.params.id]);
  await recordTaskEvent({ userId: req.user.id, taskId: req.params.id, eventType: 'subtask_created', title: task.rows[0].title, priority: task.rows[0].priority, metadata: { subtaskTitle: rows[0].title } });
  res.status(201).json({ subtask: rows[0] });
}));
app.patch('/api/subtasks/:id', auth, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`UPDATE subtasks s SET completed=$1 FROM tasks t WHERE s.id=$2 AND s.task_id=t.id AND t.user_id=$3 RETURNING s.*,t.title task_title,t.priority task_priority`, [Boolean(req.body.completed), req.params.id, req.user.id]); if (!rows[0]) return res.status(404).json({ error: 'Subtask not found' });
  await recordTaskEvent({ userId: req.user.id, taskId: rows[0].task_id, eventType: rows[0].completed ? 'subtask_completed' : 'subtask_reopened', title: rows[0].task_title, priority: rows[0].task_priority, metadata: { subtaskTitle: rows[0].title } });
  res.json({ subtask: rows[0] });
}));
app.delete('/api/subtasks/:id', auth, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`DELETE FROM subtasks s USING tasks t WHERE s.id=$1 AND s.task_id=t.id AND t.user_id=$2 RETURNING s.id,s.task_id,s.title,t.title task_title,t.priority task_priority`, [req.params.id, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Subtask not found' });
  await recordTaskEvent({ userId: req.user.id, taskId: rows[0].task_id, eventType: 'subtask_deleted', title: rows[0].task_title, priority: rows[0].task_priority, metadata: { subtaskTitle: rows[0].title } }); res.status(204).end();
}));
app.post('/api/categories', auth, asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim(); const color = /^#[0-9a-f]{6}$/i.test(req.body.color) ? req.body.color : '#7c5cff'; if (!name) return res.status(400).json({ error: 'Category name is required' });
  const { rows } = await pool.query('INSERT INTO categories(id,user_id,name,color) VALUES($1,$2,$3,$4) RETURNING *', [randomId(), req.user.id, name, color]); res.status(201).json({ category: rows[0] });
}));

app.get('/api/journal/preview', auth, asyncRoute(async (req, res) => {
  const input = { periodType: req.query.periodType, from: req.query.from, to: req.query.to };
  res.json({ facts: await getJournalFacts(req.user.id, input) });
}));
app.post('/api/journal/generate', auth, asyncRoute(async (req, res) => {
  const input = { periodType: req.body.periodType, from: req.body.from, to: req.body.to, reflection: req.body.reflection };
  res.status(201).json(await generateJournal(req.user.id, input));
}));
app.get('/api/journals', auth, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`SELECT id,period_type,period_start,period_end,title,provider,model,created_at FROM journal_entries WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.user.id]);
  res.json({ journals: rows });
}));
app.get('/api/journals/:id', auth, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM journal_entries WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Journal not found' }); res.json({ journal: rows[0] });
}));
app.patch('/api/journals/:id', auth, asyncRoute(async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 180); const reflection = String(req.body.reflection || '').trim().slice(0, 8000); const content = req.body.content;
  if (!title || !content || typeof content !== 'object') return res.status(400).json({ error: 'A title and journal content are required' });
  const { rows } = await pool.query('UPDATE journal_entries SET title=$1,reflection=$2,content=$3::jsonb,updated_at=NOW() WHERE id=$4 AND user_id=$5 RETURNING *', [title, reflection, JSON.stringify(content), req.params.id, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Journal not found' }); res.json({ journal: rows[0] });
}));
app.get('/api/journals/:id/download', auth, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM journal_entries WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Journal not found' }); const journal = rows[0];
  const safeName = `tmony-journal-${journal.period_start}-${journal.period_end}`;
  if (req.query.format === 'markdown') { res.set({ 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${safeName}.md"` }).send(journalMarkdown(journal)); return; }
  if (req.query.format === 'pdf') { res.set({ 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${safeName}.pdf"` }); journalPdf(journal, res); return; }
  res.status(400).json({ error: 'Choose pdf or markdown format' });
}));
app.get('/api/journal/reminder', auth, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`SELECT r.*,EXISTS(SELECT 1 FROM calendar_connections c WHERE c.user_id=$1) calendar_connected
    FROM (SELECT $1::uuid user_id) base LEFT JOIN journal_reminders r ON r.user_id=base.user_id`, [req.user.id]);
  const row = rows[0]; res.json({ reminder: { enabled: row.enabled || false, dayOfWeek: row.day_of_week ?? 0, morningTime: String(row.morning_time || '07:00').slice(0,5), eveningTime: String(row.evening_time || '19:00').slice(0,5), syncStatus: row.sync_status || 'local', syncError: row.sync_error || null, calendarConnected: row.calendar_connected } });
}));
app.put('/api/journal/reminder', auth, asyncRoute(async (req, res) => {
  const enabled = Boolean(req.body.enabled); const dayOfWeek = Number(req.body.dayOfWeek); const morningTime = String(req.body.morningTime || ''); const eveningTime = String(req.body.eveningTime || '');
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(morningTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(eveningTime) || morningTime === eveningTime) return res.status(400).json({ error: 'Choose a valid day and two different reminder times' });
  const connection = await pool.query('SELECT 1 FROM calendar_connections WHERE user_id=$1', [req.user.id]);
  if (enabled && !connection.rows[0]) return res.status(409).json({ error: 'Connect Google Calendar before enabling journal reminders' });
  await pool.query(`INSERT INTO journal_reminders(user_id,enabled,day_of_week,morning_time,evening_time,sync_status) VALUES($1,$2,$3,$4,$5,'pending')
    ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,day_of_week=EXCLUDED.day_of_week,morning_time=EXCLUDED.morning_time,evening_time=EXCLUDED.evening_time,sync_status='pending',sync_error=NULL,updated_at=NOW()`, [req.user.id, enabled, dayOfWeek, morningTime, eveningTime]);
  const reminder = await syncJournalReminder(req.user.id); res.json({ reminder: { enabled: reminder.enabled, dayOfWeek: reminder.day_of_week, morningTime: String(reminder.morning_time).slice(0,5), eveningTime: String(reminder.evening_time).slice(0,5), syncStatus: reminder.sync_status, syncError: reminder.sync_error, calendarConnected: Boolean(connection.rows[0]) } });
}));

app.post('/api/calendar/webhook', (req, res) => { res.status(204).end(); const channelId = req.headers['x-goog-channel-id']; const resourceId = req.headers['x-goog-resource-id']; if (channelId && resourceId) void handleWebhook(channelId, resourceId); });

app.use(express.static(publicDir));
app.get('*splat', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.use((error, _req, res, _next) => { console.error(error); res.status(error.status || 500).json({ error: error.status ? error.message : 'Something went wrong' }); });

export { app, ensureDemo };
