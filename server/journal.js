import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { pool } from './store.js';
import { randomId } from './security.js';

const PERIODS = new Set(['day', 'week', 'month', 'year', 'custom']);
const DAY_MS = 86400000;

function cleanDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw Object.assign(new Error(`${label} must use YYYY-MM-DD`), { status: 400 });
  return value;
}

export function validatePeriod({ periodType = 'month', from, to }) {
  if (!PERIODS.has(periodType)) throw Object.assign(new Error('Invalid journal period'), { status: 400 });
  const periodStart = cleanDate(from, 'Start date');
  const periodEnd = cleanDate(to, 'End date');
  const start = new Date(`${periodStart}T00:00:00Z`);
  const end = new Date(`${periodEnd}T00:00:00Z`);
  if (end < start) throw Object.assign(new Error('End date must be after start date'), { status: 400 });
  if ((end - start) / DAY_MS > 366) throw Object.assign(new Error('Journal periods cannot exceed 367 days'), { status: 400 });
  return { periodType, periodStart, periodEnd };
}

export async function recordTaskEvent({ userId, taskId = null, eventType, title = '', category = null, priority = null, metadata = {} }, db = pool) {
  const eventMetadata = taskId ? { originalTaskId: taskId, ...metadata } : metadata;
  await db.query(`INSERT INTO task_events(id,user_id,task_id,event_type,title_snapshot,category_snapshot,priority_snapshot,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [randomId(), userId, taskId, eventType, title, category, priority, JSON.stringify(eventMetadata)]);
}

function longestStreak(dateStrings) {
  const dates = [...new Set(dateStrings)].sort();
  let longest = 0; let current = 0; let previous = null;
  for (const value of dates) {
    const date = new Date(`${value}T00:00:00Z`);
    current = previous && (date - previous) === DAY_MS ? current + 1 : 1;
    longest = Math.max(longest, current); previous = date;
  }
  return longest;
}

export async function getJournalFacts(userId, input) {
  const { periodType, periodStart, periodEnd } = validatePeriod(input);
  const userResult = await pool.query('SELECT timezone FROM users WHERE id=$1', [userId]);
  const timezone = userResult.rows[0]?.timezone || 'UTC';
  const [taskResult, eventResult, subtaskResult, plannedResult] = await Promise.all([
    pool.query(`SELECT t.id,t.title,t.notes,t.priority,t.recurrence,t.due_at,t.completed_at,t.created_at,
      COALESCE(c.name,'Uncategorised') category_name
      FROM tasks t LEFT JOIN categories c ON c.id=t.category_id
      WHERE t.user_id=$1 AND (t.completed_at AT TIME ZONE $4) >= $2::date AND (t.completed_at AT TIME ZONE $4) < ($3::date + INTERVAL '1 day')
      ORDER BY t.completed_at`, [userId, periodStart, periodEnd, timezone]),
    pool.query(`SELECT task_id,event_type,title_snapshot,category_snapshot,priority_snapshot,occurred_at,metadata
      FROM task_events WHERE user_id=$1 AND (occurred_at AT TIME ZONE $4) >= $2::date AND (occurred_at AT TIME ZONE $4) < ($3::date + INTERVAL '1 day')
      ORDER BY occurred_at`, [userId, periodStart, periodEnd, timezone]),
    pool.query(`SELECT COUNT(*)::int total,
      COUNT(*) FILTER (WHERE te.event_type='subtask_completed')::int completed
      FROM task_events te WHERE te.user_id=$1 AND (te.occurred_at AT TIME ZONE $4) >= $2::date AND (te.occurred_at AT TIME ZONE $4) < ($3::date + INTERVAL '1 day')
      AND te.event_type IN ('subtask_created','subtask_completed')`, [userId, periodStart, periodEnd, timezone]),
    pool.query(`SELECT COUNT(*)::int count FROM tasks WHERE user_id=$1 AND (created_at AT TIME ZONE $4) < ($3::date + INTERVAL '1 day')
      AND (((due_at AT TIME ZONE $4) >= $2::date AND (due_at AT TIME ZONE $4) < ($3::date + INTERVAL '1 day')) OR ((completed_at AT TIME ZONE $4) >= $2::date AND (completed_at AT TIME ZONE $4) < ($3::date + INTERVAL '1 day')))`, [userId, periodStart, periodEnd, timezone]),
  ]);
  const events = eventResult.rows;
  const currentIds = new Set(taskResult.rows.map((task) => task.id));
  const deletedCompletionMap = new Map();
  for (const event of events.filter((item) => item.event_type === 'task_completed')) {
    const id = event.metadata?.originalTaskId || event.task_id;
    if (id && !currentIds.has(id)) deletedCompletionMap.set(id, { id, title: event.title_snapshot, notes: '', priority: event.priority_snapshot || 'medium', recurrence: 'none', due_at: null, completed_at: event.occurred_at, category_name: event.category_snapshot || 'Uncategorised' });
  }
  const deletedCompletions = [...deletedCompletionMap.values()];
  const tasks = [...taskResult.rows, ...deletedCompletions];
  const dateInZone = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
  const completedDates = tasks.map((task) => dateInZone(task.completed_at));
  const categories = {};
  for (const task of tasks) categories[task.category_name] = (categories[task.category_name] || 0) + 1;
  const created = events.filter((event) => event.event_type === 'task_created').length;
  const overdueRecovered = tasks.filter((task) => task.due_at && new Date(task.completed_at) > new Date(task.due_at)).length;
  const recurringCompleted = tasks.filter((task) => task.recurrence !== 'none').length;
  const highPriorityCompleted = tasks.filter((task) => task.priority === 'high').length;
  const plannedTasks = plannedResult.rows[0].count + deletedCompletions.length;
  const completionRate = plannedTasks ? Math.min(100, Math.round(tasks.length / plannedTasks * 100)) : 0;
  const milestones = [];
  if (tasks.length) milestones.push(`Completed ${tasks.length} task${tasks.length === 1 ? '' : 's'}`);
  if (highPriorityCompleted) milestones.push(`Finished ${highPriorityCompleted} high-priority task${highPriorityCompleted === 1 ? '' : 's'}`);
  if (recurringCompleted) milestones.push(`Kept up with ${recurringCompleted} recurring task${recurringCompleted === 1 ? '' : 's'}`);
  if (longestStreak(completedDates) > 1) milestones.push(`${longestStreak(completedDates)}-day completion streak`);
  return {
    period: { type: periodType, start: periodStart, end: periodEnd },
    metrics: { completedTasks: tasks.length, plannedTasks, tasksCreated: created, completionRate, highPriorityCompleted, recurringCompleted, overdueRecovered, subtasksCompleted: subtaskResult.rows[0].completed, longestStreak: longestStreak(completedDates) },
    categories,
    milestones,
    completedTasks: tasks.map((task) => ({ title: task.title, notes: task.notes, category: task.category_name, priority: task.priority, recurrence: task.recurrence, completedAt: task.completed_at, completionDate: dateInZone(task.completed_at), dueAt: task.due_at })),
    activityDays: completedDates.reduce((days, date) => ({ ...days, [date]: (days[date] || 0) + 1 }), {}),
  };
}

function localContent(facts, reflection) {
  const { metrics, period, completedTasks, milestones, categories } = facts;
  const categoryText = Object.entries(categories).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} (${count})`);
  return {
    title: `My progress · ${period.start} to ${period.end}`,
    overview: metrics.completedTasks ? `I completed ${metrics.completedTasks} task${metrics.completedTasks === 1 ? '' : 's'} during this period, including ${metrics.highPriorityCompleted} high-priority task${metrics.highPriorityCompleted === 1 ? '' : 's'}.` : 'No completed tasks were recorded during this period. This journal can still hold my reflection and help me reset for what comes next.',
    achievements: completedTasks.map((task) => `${task.title}${task.category ? ` — ${task.category}` : ''}`),
    milestones,
    challenges: metrics.overdueRecovered ? [`I recovered and completed ${metrics.overdueRecovered} overdue task${metrics.overdueRecovered === 1 ? '' : 's'}.`] : [],
    category_progress: categoryText,
    daily_journal: Object.keys(facts.activityDays).map((date) => { const titles = completedTasks.filter((task) => task.completionDate === date).map((task) => task.title); return { date, entry: titles.length ? `I completed ${titles.join(', ')}.` : `I completed ${facts.activityDays[date]} task${facts.activityDays[date] === 1 ? '' : 's'} today.` }; }),
    lessons: reflection ? [reflection] : [],
    next_steps: ['Choose the next meaningful task and give it a realistic due date.'],
  };
}

const responseSchema = {
  type: 'object', additionalProperties: false,
  required: ['title','overview','achievements','milestones','challenges','category_progress','daily_journal','lessons','next_steps'],
  properties: {
    title: { type: 'string' }, overview: { type: 'string' },
    achievements: { type: 'array', items: { type: 'string' } }, milestones: { type: 'array', items: { type: 'string' } },
    challenges: { type: 'array', items: { type: 'string' } }, category_progress: { type: 'array', items: { type: 'string' } },
    daily_journal: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['date','entry'], properties: { date: { type: 'string' }, entry: { type: 'string' } } } },
    lessons: { type: 'array', items: { type: 'string' } }, next_steps: { type: 'array', items: { type: 'string' } },
  },
};

async function groqContent(facts, reflection, model) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model, temperature: 0.3, max_completion_tokens: 3000,
      messages: [
        { role: 'system', content: 'Write a warm first-person progress journal using ONLY the supplied verified facts and personal reflection. Never invent tasks, dates, emotions, achievements, or numbers. If data is absent, leave the relevant array empty. Keep task titles accurate. Make the overview detailed but concise.' },
        { role: 'user', content: JSON.stringify({ verifiedFacts: facts, personalReflection: reflection || 'No personal reflection supplied.' }) },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'tmony_journal', strict: true, schema: responseSchema } },
    }),
  });
  if (!response.ok) throw new Error(`Groq returned ${response.status}`);
  const data = await response.json();
  return JSON.parse(data.choices?.[0]?.message?.content || '{}');
}

export async function generateJournal(userId, input) {
  const facts = await getJournalFacts(userId, input);
  const reflection = String(input.reflection || '').trim().slice(0, 8000);
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify({ userId, facts, reflection, mode: process.env.GROQ_API_KEY ? 'groq' : 'local' })).digest('hex');
  const cached = await pool.query('SELECT * FROM journal_entries WHERE user_id=$1 AND cache_key=$2', [userId, cacheKey]);
  if (cached.rows[0]) return { journal: cached.rows[0], cached: true };
  let provider = 'local'; let model = null; let content;
  if (process.env.GROQ_API_KEY) {
    const count = await pool.query("SELECT COUNT(*)::int count FROM journal_entries WHERE user_id=$1 AND provider='groq' AND created_at >= CURRENT_DATE", [userId]);
    if (count.rows[0].count >= 3) throw Object.assign(new Error('You have used today’s 3 AI journal generations. The facts preview and saved journals remain available.'), { status: 429 });
    model = input.periodType === 'month' || input.periodType === 'year' ? (process.env.GROQ_LONG_MODEL || 'openai/gpt-oss-120b') : (process.env.GROQ_DAILY_MODEL || 'openai/gpt-oss-20b');
    try { content = await groqContent(facts, reflection, model); provider = 'groq'; }
    catch (error) { console.error('Groq journal fallback:', error.message); model = null; content = localContent(facts, reflection); }
  } else content = localContent(facts, reflection);
  const id = randomId();
  const saved = await pool.query(`INSERT INTO journal_entries(id,user_id,period_type,period_start,period_end,title,reflection,facts,content,provider,model,cache_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12) RETURNING *`, [id, userId, facts.period.type, facts.period.start, facts.period.end, content.title, reflection, JSON.stringify(facts), JSON.stringify(content), provider, model, cacheKey]);
  return { journal: saved.rows[0], cached: false };
}

export function journalMarkdown(journal) {
  const content = journal.content;
  const list = (title, values) => values?.length ? `\n## ${title}\n\n${values.map((value) => `- ${value}`).join('\n')}\n` : '';
  return `# ${content.title}\n\n**Period:** ${journal.period_start} to ${journal.period_end}\n\n${content.overview}\n${list('Achievements', content.achievements)}${list('Milestones', content.milestones)}${list('Challenges', content.challenges)}${list('Category progress', content.category_progress)}${content.daily_journal?.length ? `\n## Daily journal\n\n${content.daily_journal.map((item) => `### ${item.date}\n\n${item.entry}`).join('\n\n')}\n` : ''}${list('Lessons and reflections', content.lessons)}${list('Next steps', content.next_steps)}${journal.reflection ? `\n## My original reflection\n\n${journal.reflection}\n` : ''}\n---\nGenerated by Tmony from verified task activity.\n`;
}

export function journalPdf(journal, response) {
  const doc = new PDFDocument({ size: 'A4', margin: 54, info: { Title: journal.title, Author: 'Tmony' } });
  doc.pipe(response); const content = journal.content;
  doc.fillColor('#7657e7').fontSize(11).text('TMONY JOURNAL');
  doc.moveDown(.5).fillColor('#211f2d').fontSize(24).text(content.title);
  doc.moveDown(.3).fillColor('#7e7a8f').fontSize(10).text(`${journal.period_start} to ${journal.period_end}`);
  doc.moveDown().fillColor('#211f2d').fontSize(11).text(content.overview, { lineGap: 4 });
  const section = (title, values) => { if (!values?.length) return; doc.moveDown().fillColor('#7657e7').fontSize(14).text(title); doc.moveDown(.3).fillColor('#211f2d').fontSize(10); values.forEach((value) => doc.text(`• ${value}`, { indent: 8, lineGap: 3 })); };
  section('Achievements', content.achievements); section('Milestones', content.milestones); section('Challenges', content.challenges); section('Category progress', content.category_progress);
  if (content.daily_journal?.length) { doc.addPage(); doc.fillColor('#7657e7').fontSize(16).text('Daily journal'); content.daily_journal.forEach((item) => { doc.moveDown().fillColor('#211f2d').fontSize(11).text(item.date); doc.fillColor('#55505f').fontSize(10).text(item.entry, { lineGap: 3 }); }); }
  section('Lessons and reflections', content.lessons); section('Next steps', content.next_steps);
  if (journal.reflection) section('My original reflection', [journal.reflection]);
  doc.moveDown(2).fillColor('#9a95a5').fontSize(8).text('Generated by Tmony from verified task activity.'); doc.end();
}
