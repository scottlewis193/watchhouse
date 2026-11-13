import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartupReporter } from '../src/lib/startup-reports.js';

function harness() {
  let at = 0, timer, current = null, sequence = 0;
  const reports = [];
  const reporter = createStartupReporter({ capture: () => current, send: report => reports.push(report),
    now: () => at, wallNow: () => 1000 + at, schedule: callback => { timer = callback; return callback; }, cancel() {}, identify: () => `attempt-${++sequence}` });
  return { reporter, reports, at: value => { at = value; }, deadline: () => timer(), getDeadline: () => timer, capture: value => { current = value; } };
}

test('records a selection exceeding ten seconds before a job exists and later records advancing playback', () => {
  const h = harness();
  h.reporter.start({ id: 1, type: 'movie', title: 'Example', releaseId: 'selected', nzbUrl: 'https://private.test/?apikey=secret' });
  h.at(10000); h.deadline();
  assert.equal(h.reports[1].jobId, null);
  assert.equal(h.reports[1].incident.outcome, 'slow');
  assert.equal(h.reports[1].incident.stage, 'requesting-release');
  assert.equal(h.reports[1].incident.durationMs, 10000);
  assert.equal(JSON.stringify(h.reports).includes('secret'), false);
  h.at(12000); h.reporter.job({ id: 'job', status: 'preparing' });
  h.capture({ jobId: 'job', snapshot: { readyState: 4 }, job: { token: 'private' } });
  h.reporter.job({ id: 'job', status: 'ready' });
  h.reporter.stage('loading-buffer');
  h.at(13500); h.reporter.finish('playing');
  const result = h.reports.at(-1);
  assert.equal(result.incident.id, h.reports[0].incident.id);
  assert.equal(result.incident.durationMs, 13500);
  assert.equal(result.incident.metTarget, false);
  assert.equal(result.snapshot.readyState, 4);
  assert.equal(result.job.token, '<REDACTED>');
});

test('superseded attempts cannot inherit an old job or fire a late deadline', () => {
  const h = harness();
  h.reporter.start({ id: 1 });
  const oldDeadline = h.getDeadline();
  h.reporter.job({ id: 'old', status: 'ready' });
  h.capture({ jobId: 'old', snapshot: { position: 500 } });
  h.at(100); h.reporter.start({ id: 2 });
  assert.equal(h.reports.at(-2).incident.outcome, 'cancelled');
  assert.equal(h.reports.at(-1).jobId, null);
  assert.equal(h.reports.at(-1).snapshot, undefined);
  h.at(900); h.reporter.finish('failed', { message: 'No usable release' });
  const count = h.reports.length;
  oldDeadline(); h.reporter.finish('playing');
  assert.equal(h.reports.length, count);
  assert.equal(h.reports.at(-1).incident.outcome, 'failed');
});

test('fast starts meet the target, and failed diagnostic transport never throws into playback', async () => {
  const h = harness();
  h.reporter.start({ id: 1 }); h.at(9000); h.reporter.finish('playing');
  assert.equal(h.reports.at(-1).incident.metTarget, true);
  const reporter = createStartupReporter({ capture: () => null, send: () => Promise.reject(new Error('offline')), schedule: () => 0, cancel() {}, identify: () => 'offline' });
  reporter.start({ id: 2 }); reporter.finish('failed');
  await new Promise(resolve => setImmediate(resolve));
});
