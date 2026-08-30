import { pool } from './store.js';
import { decryptSecret, encryptSecret, randomId, required } from './security.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

export function recurrenceLines(recurrence) {
  const rules = { daily: 'RRULE:FREQ=DAILY', weekly: 'RRULE:FREQ=WEEKLY', monthly: 'RRULE:FREQ=MONTHLY' };
  return rules[recurrence] ? [rules[recurrence]] : undefined;
}

export function eventFromTask(task, appUrl) {
  if (!task.due_at) return null;
  const start = new Date(task.due_at);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    summary: task.completed ? `✓ ${task.title}` : task.title,
    description: `${task.notes || ''}\n\nManaged by Tmony: ${appUrl}`.trim(),
    start: { dateTime: start.toISOString(), timeZone: 'Africa/Lagos' },
    end: { dateTime: end.toISOString(), timeZone: 'Africa/Lagos' },
    recurrence: recurrenceLines(task.recurrence),
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: task.reminder_minutes ?? 30 }] },
    extendedProperties: { private: { testimonyTaskId: task.id, testimonyUserId: task.user_id } },
  };
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function localDateParts(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

export function journalReminderEvent({ userId, timezone, dayOfWeek, time, label, appUrl, now = new Date() }) {
  const local = localDateParts(timezone, now); const currentDay = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(local.weekday);
  const currentMinutes = Number(local.hour) * 60 + Number(local.minute); const [hour, minute] = time.slice(0, 5).split(':').map(Number);
  let daysAhead = (dayOfWeek - currentDay + 7) % 7;
  if (daysAhead === 0 && currentMinutes >= hour * 60 + minute) daysAhead = 7;
  const startValue = new Date(Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day) + daysAhead, hour, minute));
  const endValue = new Date(startValue.getTime() + 30 * 60000); const day = startValue.toISOString().slice(0, 10); const endDay = endValue.toISOString().slice(0, 10); const endTime = endValue.toISOString().slice(11, 16);
  return {
    summary: `Tmony weekly progress review · ${label}`,
    description: `Review completed tasks, achievements, milestones, and reflections in My Journal.\n\nOpen Tmony: ${appUrl}`,
    start: { dateTime: `${day}T${time.slice(0, 5)}:00`, timeZone: timezone },
    end: { dateTime: `${endDay}T${endTime}:00`, timeZone: timezone },
    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${WEEKDAYS[dayOfWeek]}`],
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
    extendedProperties: { private: { tmonyJournalReminder: label.toLowerCase(), tmonyUserId: userId } },
  };
}

export function patchFromEvent(event) {
  const rawTitle = event.summary || 'Untitled calendar task';
  return {
    title: rawTitle.replace(/^✓\s*/, ''),
    completed: event.status === 'cancelled' || /^✓\s*/.test(rawTitle),
    dueAt: event.start?.dateTime || (event.start?.date ? `${event.start.date}T09:00:00.000Z` : null),
    notes: (event.description || '').split(/\n\nManaged by (?:Tmony|Testimony Tasks):/)[0],
    etag: event.etag || null,
  };
}

function redirectUri(purpose) {
  return `${required('APP_URL')}/api/google/${purpose}/callback`;
}

export function googleAuthUrl({ state, purpose }) {
  const calendar = purpose === 'calendar';
  const scopes = calendar
    ? ['https://www.googleapis.com/auth/calendar.events']
    : ['openid', 'email', 'profile'];
  const params = new URLSearchParams({
    client_id: required('GOOGLE_CLIENT_ID'), redirect_uri: redirectUri(purpose), response_type: 'code',
    scope: scopes.join(' '), state, access_type: calendar ? 'offline' : 'online', include_granted_scopes: 'true',
    prompt: calendar ? 'consent' : 'select_account',
  });
  return `${GOOGLE_AUTH}?${params}`;
}

export async function exchangeCode(code, purpose) {
  const response = await fetch(GOOGLE_TOKEN, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: required('GOOGLE_CLIENT_ID'), client_secret: required('GOOGLE_CLIENT_SECRET'), redirect_uri: redirectUri(purpose), grant_type: 'authorization_code' }),
  });
  if (!response.ok) throw new Error(`Google token exchange failed (${response.status})`);
  return response.json();
}

export async function googleProfile(accessToken) {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error('Could not read Google profile');
  return response.json();
}

async function accessTokenFor(userId) {
  const { rows } = await pool.query('SELECT encrypted_refresh_token FROM calendar_connections WHERE user_id=$1', [userId]);
  if (!rows[0]) throw new Error('Google Calendar is not connected');
  const response = await fetch(GOOGLE_TOKEN, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: required('GOOGLE_CLIENT_ID'), client_secret: required('GOOGLE_CLIENT_SECRET'), refresh_token: decryptSecret(rows[0].encrypted_refresh_token), grant_type: 'refresh_token' }),
  });
  if (!response.ok) throw new Error('Google Calendar authorization expired; reconnect it');
  return (await response.json()).access_token;
}

async function calendarFetch(userId, path, options = {}) {
  const token = await accessTokenFor(userId);
  const response = await fetch(`${CALENDAR_API}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...options.headers },
  });
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(`Google Calendar request failed (${response.status})`);
    error.status = response.status; error.detail = detail;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

export async function saveCalendarConnection(userId, refreshToken) {
  if (!refreshToken) throw new Error('Google did not return a refresh token; remove access and reconnect');
  await pool.query(`INSERT INTO calendar_connections(user_id, encrypted_refresh_token) VALUES($1,$2)
    ON CONFLICT(user_id) DO UPDATE SET encrypted_refresh_token=EXCLUDED.encrypted_refresh_token, updated_at=NOW()`, [userId, encryptSecret(refreshToken)]);
  await fullSync(userId);
  const { rows } = await pool.query('SELECT * FROM tasks WHERE user_id=$1 AND due_at IS NOT NULL', [userId]);
  for (const task of rows) await syncTaskToCalendar(task);
  const reminder = await pool.query('SELECT enabled FROM journal_reminders WHERE user_id=$1', [userId]);
  if (reminder.rows[0]?.enabled) await syncJournalReminder(userId);
  if (required('APP_URL').startsWith('https://')) await createWatch(userId);
}

export async function syncJournalReminder(userId) {
  const { rows } = await pool.query(`SELECT r.*,u.timezone FROM journal_reminders r JOIN users u ON u.id=r.user_id WHERE r.user_id=$1`, [userId]);
  const reminder = rows[0]; if (!reminder) return null;
  const eventColumns = [['morning', 'morning_time', 'morning_event_id'], ['evening', 'evening_time', 'evening_event_id']];
  if (!reminder.enabled) {
    for (const [, , idColumn] of eventColumns) if (reminder[idColumn]) await deleteCalendarEvent(userId, reminder[idColumn]);
    const result = await pool.query("UPDATE journal_reminders SET morning_event_id=NULL,evening_event_id=NULL,sync_status='local',sync_error=NULL,updated_at=NOW() WHERE user_id=$1 RETURNING *", [userId]); return result.rows[0];
  }
  try {
    const ids = {};
    for (const [label, timeColumn, idColumn] of eventColumns) {
      const body = JSON.stringify(journalReminderEvent({ userId, timezone: reminder.timezone, dayOfWeek: reminder.day_of_week, time: String(reminder[timeColumn]), label, appUrl: required('APP_URL') }));
      let event;
      if (reminder[idColumn]) {
        try { event = await calendarFetch(userId, `/calendars/primary/events/${encodeURIComponent(reminder[idColumn])}`, { method: 'PATCH', body }); }
        catch (error) { if (error.status !== 404 && error.status !== 410) throw error; }
      }
      if (!event) event = await calendarFetch(userId, '/calendars/primary/events', { method: 'POST', body });
      ids[idColumn] = event.id;
    }
    const result = await pool.query("UPDATE journal_reminders SET morning_event_id=$2,evening_event_id=$3,sync_status='synced',sync_error=NULL,updated_at=NOW() WHERE user_id=$1 RETURNING *", [userId, ids.morning_event_id, ids.evening_event_id]); return result.rows[0];
  } catch (error) {
    await pool.query("UPDATE journal_reminders SET sync_status='error',sync_error=$2,updated_at=NOW() WHERE user_id=$1", [userId, error.message]); error.status = error.status || 502; throw error;
  }
}

export async function syncTaskToCalendar(task) {
  const connection = await pool.query('SELECT 1 FROM calendar_connections WHERE user_id=$1', [task.user_id]);
  if (!connection.rows[0]) {
    await pool.query("UPDATE tasks SET sync_status='local', sync_error=NULL WHERE id=$1", [task.id]);
    return;
  }
  if (!task.due_at) {
    try {
      if (task.google_event_id) await deleteCalendarEvent(task.user_id, task.google_event_id);
      await pool.query("UPDATE tasks SET google_event_id=NULL, google_etag=NULL, sync_status='local', sync_error=NULL WHERE id=$1", [task.id]);
    } catch (error) {
      await pool.query("UPDATE tasks SET sync_status='error', sync_error=$2 WHERE id=$1", [task.id, error.message]);
    }
    return;
  }
  try {
    const body = JSON.stringify(eventFromTask(task, required('APP_URL')));
    const path = task.google_event_id
      ? `/calendars/primary/events/${encodeURIComponent(task.google_event_id)}`
      : '/calendars/primary/events';
    const event = await calendarFetch(task.user_id, path, { method: task.google_event_id ? 'PATCH' : 'POST', body });
    await pool.query("UPDATE tasks SET google_event_id=$2, google_etag=$3, sync_status='synced', sync_error=NULL WHERE id=$1", [task.id, event.id, event.etag]);
  } catch (error) {
    await pool.query("UPDATE tasks SET sync_status='error', sync_error=$2 WHERE id=$1", [task.id, error.message]);
  }
}

export async function deleteCalendarEvent(userId, eventId) {
  try { await calendarFetch(userId, `/calendars/primary/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' }); }
  catch (error) { if (error.status !== 404 && error.status !== 410) throw error; }
}

async function applyRemoteEvents(userId, events) {
  for (const event of events) {
    const taskId = event.extendedProperties?.private?.testimonyTaskId;
    if (!taskId) continue;
    if (event.status === 'cancelled') {
      await pool.query("UPDATE tasks SET due_at=NULL, google_event_id=NULL, google_etag=NULL, sync_status='local', updated_at=NOW() WHERE id=$1 AND user_id=$2", [taskId, userId]);
      continue;
    }
    const patch = patchFromEvent(event);
    await pool.query(`UPDATE tasks SET title=$3, notes=$4, completed=$5, due_at=$6, google_event_id=$7,
      google_etag=$8, sync_status='synced', sync_error=NULL, updated_at=NOW() WHERE id=$1 AND user_id=$2`,
      [taskId, userId, patch.title, patch.notes, patch.completed, patch.dueAt, event.id, patch.etag]);
  }
}

export async function fullSync(userId) {
  let pageToken; let nextSyncToken;
  do {
    const query = new URLSearchParams({ singleEvents: 'false', showDeleted: 'true', maxResults: '2500' });
    if (pageToken) query.set('pageToken', pageToken);
    const data = await calendarFetch(userId, `/calendars/primary/events?${query}`);
    await applyRemoteEvents(userId, data.items || []);
    pageToken = data.nextPageToken; nextSyncToken = data.nextSyncToken || nextSyncToken;
  } while (pageToken);
  if (nextSyncToken) await pool.query('UPDATE calendar_connections SET sync_token=$2, updated_at=NOW() WHERE user_id=$1', [userId, nextSyncToken]);
}

export async function incrementalSync(userId) {
  const { rows } = await pool.query('SELECT sync_token FROM calendar_connections WHERE user_id=$1', [userId]);
  if (!rows[0]?.sync_token) return fullSync(userId);
  try {
    let pageToken; let nextSyncToken;
    do {
      const query = new URLSearchParams({ syncToken: rows[0].sync_token, showDeleted: 'true' });
      if (pageToken) query.set('pageToken', pageToken);
      const data = await calendarFetch(userId, `/calendars/primary/events?${query}`);
      await applyRemoteEvents(userId, data.items || []);
      pageToken = data.nextPageToken; nextSyncToken = data.nextSyncToken || nextSyncToken;
    } while (pageToken);
    if (nextSyncToken) await pool.query('UPDATE calendar_connections SET sync_token=$2, updated_at=NOW() WHERE user_id=$1', [userId, nextSyncToken]);
  } catch (error) {
    if (error.status === 410) return fullSync(userId);
    throw error;
  }
}

export async function createWatch(userId) {
  const channelId = randomId();
  const expiration = Date.now() + 6 * 24 * 60 * 60 * 1000;
  const data = await calendarFetch(userId, '/calendars/primary/events/watch', {
    method: 'POST', body: JSON.stringify({ id: channelId, type: 'web_hook', address: `${required('APP_URL')}/api/calendar/webhook`, expiration }),
  });
  await pool.query(`UPDATE calendar_connections SET channel_id=$2, channel_resource_id=$3,
    channel_expires_at=to_timestamp($4 / 1000.0), updated_at=NOW() WHERE user_id=$1`, [userId, channelId, data.resourceId, Number(data.expiration || expiration)]);
}

export async function renewExpiringWatches() {
  const { rows } = await pool.query("SELECT user_id FROM calendar_connections WHERE channel_expires_at < NOW() + INTERVAL '24 hours'");
  await Promise.allSettled(rows.map(({ user_id }) => createWatch(user_id)));
}

export async function handleWebhook(channelId, resourceId) {
  const { rows } = await pool.query('SELECT user_id FROM calendar_connections WHERE channel_id=$1 AND channel_resource_id=$2', [channelId, resourceId]);
  if (rows[0]) await incrementalSync(rows[0].user_id);
}
