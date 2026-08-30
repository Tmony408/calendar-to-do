import test from 'node:test';
import assert from 'node:assert/strict';

process.env.APP_URL = 'http://localhost:3000';
process.env.JWT_SECRET = 'a'.repeat(32);
process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);

const { eventFromTask, journalReminderEvent, patchFromEvent, recurrenceLines } = await import('../server/calendar.js');
const { decryptSecret, encryptSecret } = await import('../server/security.js');

test('encrypts refresh tokens with authenticated encryption', () => {
  const encrypted = encryptSecret('refresh-token');
  assert.notEqual(encrypted, 'refresh-token');
  assert.equal(decryptSecret(encrypted), 'refresh-token');
});

test('maps recurring tasks to Google recurrence rules', () => {
  assert.deepEqual(recurrenceLines('daily'), ['RRULE:FREQ=DAILY']);
  assert.deepEqual(recurrenceLines('weekly'), ['RRULE:FREQ=WEEKLY']);
  assert.equal(recurrenceLines('none'), undefined);
});

test('creates a tagged calendar event with a reminder', () => {
  const task = { id:'task-1', user_id:'user-1', title:'Focus session', notes:'Ship it', due_at:'2026-08-30T10:00:00.000Z', recurrence:'weekly', reminder_minutes:30, completed:false };
  const event = eventFromTask(task, 'https://tasks.example.com');
  assert.equal(event.summary, 'Focus session');
  assert.equal(event.extendedProperties.private.testimonyTaskId, 'task-1');
  assert.deepEqual(event.reminders.overrides, [{ method:'popup', minutes:30 }]);
  assert.equal(event.end.dateTime, '2026-08-30T10:30:00.000Z');
});

test('converts a remote Google event edit back into a task patch', () => {
  const patch = patchFromEvent({ summary:'✓ Updated remotely', description:'Notes\n\nManaged by Tmony:https://x', status:'confirmed', start:{dateTime:'2026-09-01T08:00:00Z'}, etag:'abc' });
  assert.equal(patch.title, 'Updated remotely'); assert.equal(patch.completed, true); assert.equal(patch.notes, 'Notes'); assert.equal(patch.etag, 'abc');
});

test('creates a weekly journal reminder in the user timezone', () => {
  const event = journalReminderEvent({ userId:'user-1', timezone:'Africa/Lagos', dayOfWeek:0, time:'07:00', label:'morning', appUrl:'https://tmony.example.com', now:new Date('2026-08-30T12:00:00Z') });
  assert.equal(event.summary, 'Tmony weekly progress review · morning');
  assert.deepEqual(event.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=SU']);
  assert.deepEqual(event.start, { dateTime:'2026-09-06T07:00:00', timeZone:'Africa/Lagos' });
  assert.deepEqual(event.reminders.overrides, [{ method:'popup', minutes:0 }]);
  assert.equal(event.extendedProperties.private.tmonyJournalReminder, 'morning');
});
