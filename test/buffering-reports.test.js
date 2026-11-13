import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createBufferingReporter } from '../src/lib/buffering-reports.js';
import { createBufferingReportStore, readBufferingReport, MAX_BUFFERING_REPORT_BYTES } from '../src/lib/server/buffering-reports.js';

test('ignores short waits, captures a sustained stall before retry, and updates its outcome', async () => {
  let at = 0, timer, cancelled;
  let state = { jobId: 'silo', source: 'silo:0', snapshot: { position: 1500 }, samples: [{ position: 1499 }] };
  const sent = [];
  const reporter = createBufferingReporter({ capture: () => state, send: value => sent.push(value),
    now: () => at, schedule: callback => { timer = callback; return 1; }, cancel: id => { cancelled = id; } });
  reporter.start('waiting'); at = 1000; reporter.finish();
  assert.equal(cancelled, 1); assert.equal(sent.length, 0);
  reporter.start('waiting'); state.snapshot.position = 1501;
  reporter.start('stalled'); at = 4000; timer();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].incident.snapshot.position, 1500, 'preserve the start snapshot before mutable player state changes');
  assert.equal(sent[0].incident.durationMs, 3000);
  at = 11000; reporter.finish('interrupted');
  assert.equal(sent[1].incident.id, sent[0].incident.id);
  assert.equal(sent[1].incident.outcome, 'interrupted');
  assert.equal(sent[1].incident.durationMs, 10000);
  state = { jobId: 'next', source: 'next:0', samples: [] };
  assert.equal(sent[0].jobId, 'silo');
});

test('reporting failures and source changes cannot break playback or misattribute a stall', async () => {
  let state = { jobId: 'old', source: 'old:0', samples: [] }, timer;
  const sent = [];
  const reporter = createBufferingReporter({ capture: () => state,
    send: report => { sent.push(report); return Promise.reject(new Error('offline')); }, schedule: callback => { timer = callback; }, cancel() {} });
  reporter.start('waiting'); state = { jobId: 'new', source: 'new:0', samples: [] }; timer(); reporter.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 2); assert.ok(sent.every(report => report.jobId === 'old'));
});

test('saved reports survive a fresh store, redact secrets, serialize writes and bound history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchhouse-reports-'));
  const path = join(root, 'data', 'playback-diagnostics.json');
  try {
    const store = createBufferingReportStore(path, { limit: 2 });
    const input = id => ({ jobId: 'silo', incident: { id, outcome: 'buffering' }, job: { token: 'secret' }, samples: [{ message: 'https://private.test/path' }] });
    await Promise.all([store.save(input('one')), store.save(input('two')), store.save(input('three'))]);
    await store.save({ ...input('three'), incident: { id: 'three', outcome: 'recovered', durationMs: 5000 } });
    await store.save({ ...input('three'), incident: { id: 'three', outcome: 'buffering', durationMs: 3000 } });
    const reports = await createBufferingReportStore(path).list();
    assert.deepEqual(reports.map(report => report.incident.id), ['two', 'three']);
    assert.equal(reports[1].incident.outcome, 'recovered');
    assert.equal(reports[1].job.token, '<REDACTED>');
    assert.equal(reports[1].samples[0].message, '<REDACTED_URL>');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects malformed and oversized browser reports before saving', async () => {
  await assert.rejects(readBufferingReport(Readable.from(['{}'])), /valid buffering report/);
  await assert.rejects(readBufferingReport(Readable.from(['x'.repeat(MAX_BUFFERING_REPORT_BYTES + 1)])), /too large/);
  const value = { jobId: 'silo', incident: { id: 'one', outcome: 'buffering' } };
  assert.deepEqual(await readBufferingReport(Readable.from([JSON.stringify(value)])), value);
});

const startupReport = (overrides = {}) => ({
  jobId: null, media: { id: 42, type: 'movie', title: 'Example' },
  incident: { kind: 'startup', id: 'attempt-one', startedAt: 1000, durationMs: 0, outcome: 'started', targetMs: 10000, stage: 'selection', ...overrides }
});

test('accepts startup reports before a job exists and rejects invalid startup contracts', async () => {
  const input = startupReport();
  assert.deepEqual(await readBufferingReport(Readable.from([JSON.stringify(input)])), input);
  for (const incident of [
    { outcome: 'buffering' }, { durationMs: -1 }, { durationMs: null }, { startedAt: '1000' },
    { targetMs: 3000 }, { stage: '' }, { id: '' }
  ]) {
    await assert.rejects(readBufferingReport(Readable.from([JSON.stringify(startupReport(incident))])), /valid startup report/);
  }
  for (const jobId of [undefined, 42, '']) {
    await assert.rejects(readBufferingReport(Readable.from([JSON.stringify({ ...input, jobId })])), /valid startup report/);
  }
  await assert.rejects(readBufferingReport(Readable.from([JSON.stringify({ jobId: null, incident: { id: 'stall', outcome: 'buffering' } })])), /valid buffering report/);
});

test('startup identity survives job attachment and delayed nonterminal uploads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchhouse-startup-reports-'));
  try {
    const path = join(root, 'reports.json');
    const store = createBufferingReportStore(path);
    await store.save(startupReport());
    await store.save({ ...startupReport({ durationMs: 10000, outcome: 'slow' }), jobId: 'attached',
      job: { id: 'attached', events: [{ message: 'https://private.test/path' }], releaseSelection: { token: 'private' } } });
    await store.save(startupReport({ durationMs: 10000, outcome: 'slow' }));
    let reports = await store.list();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].jobId, 'attached');
    assert.equal(reports[0].job.releaseSelection.token, '<REDACTED>');
    assert.equal(reports[0].job.events[0].message, '<REDACTED_URL>');
    await store.save({ ...startupReport({ durationMs: 10000, outcome: 'playing', stage: 'advancing' }), jobId: 'attached', job: reports[0].job });
    await store.save(startupReport({ durationMs: 10000, outcome: 'slow' }));
    await store.save(startupReport({ durationMs: 11000, outcome: 'slow' }));
    reports = await createBufferingReportStore(path).list();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].incident.outcome, 'playing');
    assert.equal(reports[0].jobId, 'attached');
    // Buffering incidents retain job-scoped identity even if their ID matches a startup.
    await store.save({ jobId: 'attached', incident: { id: 'attempt-one', outcome: 'buffering' } });
    assert.equal((await store.list()).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
