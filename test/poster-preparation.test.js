import test from 'node:test';
import assert from 'node:assert/strict';
import { createPosterPreparation } from '../src/lib/server/poster-preparation.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('poster preparation retains several resumable titles without cancelling earlier warm state', async () => {
  const manager = createPosterPreparation({ maximum: 3 });
  const jobs = [{ status: 'ready' }, { status: 'ready' }, { status: 'ready' }];
  for (let index = 0; index < jobs.length; index++) {
    manager.start(String(index), jobs[index], async () => {}, async () => {});
    await tick();
  }
  assert.equal(manager.take('0'), jobs[0]);
  assert.equal(manager.take('1'), jobs[1]);
  assert.equal(manager.take('2'), jobs[2]);
});

test('poster preparation deduplicates independent work and hands the same job to playback', async () => {
  const manager = createPosterPreparation();
  const first = { status: 'selecting' }, second = { status: 'selecting' };
  let firstSignal, secondSignal, calls = 0, finish;
  const gate = new Promise(resolve => { finish = resolve; });
  manager.start('one', first, async signal => { firstSignal = signal; calls++; await gate; }, async () => {});
  assert.equal(manager.start('one', {}, () => { calls++; }, () => {}), first);
  manager.start('two', second, async signal => { secondSignal = signal; await gate; }, async () => {});
  assert.equal(firstSignal.aborted, false);
  assert.equal(manager.take('two'), second);
  manager.cancel();
  assert.equal(secondSignal.aborted, false, 'taking ownership must remove speculative cancellation');
  assert.equal(firstSignal.aborted, true, 'unclaimed work is still cancellable');
  assert.equal(calls, 1); finish(); await tick();
});
test('unused poster work stops at its time budget', async () => {
  const manager = createPosterPreparation({ budgetMs: 10 });
  let signal;
  manager.start('one', { status: 'selecting' }, value => { signal = value; return new Promise(resolve => value.addEventListener('abort', resolve, { once: true })); }, () => {});
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(signal.aborted, true);
  assert.equal(manager.take('one'), null);
});
