import test from 'node:test';
import assert from 'node:assert/strict';
import { journalMarkdown, validatePeriod } from '../server/journal.js';

test('validates a supported journal date range', () => {
  assert.deepEqual(validatePeriod({ periodType: 'month', from: '2026-08-01', to: '2026-08-30' }), {
    periodType: 'month', periodStart: '2026-08-01', periodEnd: '2026-08-30',
  });
});

test('rejects a backwards journal date range', () => {
  assert.throws(() => validatePeriod({ periodType: 'custom', from: '2026-08-30', to: '2026-08-01' }), /End date/);
});

test('exports journal content as Markdown', () => {
  const markdown = journalMarkdown({
    period_start: '2026-08-01', period_end: '2026-08-30', reflection: 'I learned to focus.',
    content: { title: 'A strong month', overview: 'I made steady progress.', achievements: ['Finished the launch'], milestones: [], challenges: [], category_progress: [], daily_journal: [], lessons: [], next_steps: ['Rest and review'] },
  });
  assert.match(markdown, /# A strong month/);
  assert.match(markdown, /Finished the launch/);
  assert.match(markdown, /I learned to focus/);
});
