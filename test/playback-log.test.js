import test from 'node:test';
import assert from 'node:assert/strict';
import { logPlaybackEvent } from '../src/lib/server/playback-log.js';

test('container events correlate playback without exposing credentials or private URLs', () => {
  const lines = [];
  logPlaybackEvent({ id: 'job-1', mode: 'direct', strategy: 'remux' }, 'hls-error',
    'Failed https://user:password@example.com/private?apikey=secret',
    { sessionId: 'session-2', start: 420, elapsedMs: 100, token: 'secret', nested: { password: 'secret' } },
    line => lines.push(line));
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.jobId, 'job-1');
  assert.equal(event.sessionId, 'session-2');
  assert.equal(event.start, 420);
  assert.equal(event.elapsedMs, 100);
  assert.equal(event.activity, 'hls-error');
  assert.equal(event.mode, 'direct');
  assert.ok(Number.isFinite(Date.parse(event.at)));
  assert.equal(event.token, '<REDACTED>');
  assert.equal(event.nested.password, '<REDACTED>');
  assert.equal(event.message, 'Failed <REDACTED_URL>');
  assert.doesNotMatch(lines[0], /secret|example\.com/);
});

test('a failed log writer cannot break playback', () => {
  assert.doesNotThrow(() => logPlaybackEvent({ id: 'job' }, 'ready', 'Ready', {}, () => { throw new Error('closed'); }));
});
