import test from 'node:test';
import assert from 'node:assert/strict';
import { createPosterPreparation } from '../src/lib/server/poster-preparation.js';
import { createValidatedPreparationCache } from '../src/lib/server/validated-preparation.js';
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

test('failed preparation can be retried instead of reusing a dead job', async () => {
  const manager = createPosterPreparation();
  for (const status of ['error', 'cancelled']) {
    const first = { status: 'selecting' }, retry = { status: 'selecting' };
    let finish, calls = 0;
    manager.start(status, first, async () => {
      await new Promise(resolve => { finish = resolve; });
    }, async () => {});
    first.status = status;
    assert.equal(manager.start(status, retry, async () => { calls++; }, async () => {}), retry);
    assert.equal(calls, 1);
    finish();
  }
  await tick();
  manager.cancel();
});

test('rejected preparation releases its record for retry', async () => {
  const manager = createPosterPreparation();
  const first = { status: 'selecting' }, retry = { status: 'ready' };
  manager.start('one', first, async () => { throw new Error('Indexer unavailable'); }, async () => {});
  await tick();
  assert.equal(manager.take('one'), null);
  assert.equal(manager.start('one', retry, async () => {}, async () => {}), retry);
  await tick();
  assert.equal(manager.take('one'), retry);
});

test('a new Play intent replaces only the previous intent and retains saved resumes', async () => {
  const manager = createPosterPreparation({ maximum: 2 });
  const signals = {};
  const hold = name => signal => {
    signals[name] = signal;
    return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  };
  const saved = { status: 'selecting' }, first = { status: 'selecting' }, next = { status: 'selecting' };
  manager.start('saved', saved, hold('saved'), async () => {});
  manager.start('first', first, hold('first'), async () => {}, { intent: true, requestId: 'first-hover' });
  manager.start('next', next, hold('next'), async () => {}, { intent: true, requestId: 'next-hover' });
  assert.equal(signals.first.aborted, true);
  assert.equal(signals.saved.aborted, false);
  assert.equal(signals.next.aborted, false);
  assert.equal(manager.cancelIntent('first-hover'), false);
  assert.equal(manager.take('saved'), saved);
  assert.equal(manager.cancelIntent('next-hover'), true);
  assert.equal(signals.next.aborted, true);
  assert.equal(manager.take('next'), null);
  manager.cancel();
  await tick();
});

test('late abandonment cannot cancel a Play intent already taken by playback', async () => {
  const manager = createPosterPreparation();
  const job = { status: 'ready' };
  let signal, claimed, finish;
  manager.start('movie', job, async value => { signal = value; }, async (_signal, isClaimed) => {
    claimed = isClaimed;
    await new Promise(resolve => { finish = resolve; });
  }, { intent: true, requestId: 'play-click' });
  await tick();
  assert.equal(claimed(), false);
  assert.equal(manager.take('movie'), job);
  assert.equal(claimed(), true);
  assert.equal(manager.cancelIntent('play-click'), false);
  manager.delete('movie');
  manager.cancel();
  assert.equal(signal.aborted, false);
  finish();
  await tick();
});

test('claiming playback stops in-flight optional warming without aborting preparation or its validated source', async () => {
  const manager = createPosterPreparation();
  const job = { status: 'ready' };
  let preparationSignal, warmingSignal, warmingStopped = false;
  manager.start('movie', job, async signal => { preparationSignal = signal; }, async (_signal, _claimed, claimSignal) => {
    warmingSignal = claimSignal;
    await new Promise(resolve => claimSignal.addEventListener('abort', resolve, { once: true }));
    warmingStopped = true;
  }, { intent: true, requestId: 'warming-click' });
  await tick();
  assert.ok(warmingSignal, 'optional warming must have an independent claim cancellation signal');
  assert.equal(warmingSignal.aborted, false);
  assert.equal(manager.take('movie'), job);
  assert.equal(warmingSignal.aborted, true);
  assert.equal(preparationSignal.aborted, false, 'foreground must retain its preparation and validation signal');
  assert.equal(manager.cancelIntent('warming-click'), false);
  await tick();
  assert.equal(warmingStopped, true);
  assert.equal(preparationSignal.aborted, false);
});

test('re-entering the same Play target transfers cancellation ownership without restarting work', async () => {
  const manager = createPosterPreparation();
  const job = { status: 'selecting' };
  let signal, calls = 0;
  const prepare = value => {
    signal = value; calls++;
    return new Promise(resolve => value.addEventListener('abort', resolve, { once: true }));
  };
  manager.start('episode', job, prepare, async () => {}, { intent: true, requestId: 'old-hover' });
  assert.equal(manager.start('episode', {}, prepare, async () => {}, { intent: true, requestId: 'new-hover' }), job);
  assert.equal(calls, 1);
  assert.equal(manager.cancelIntent('old-hover'), false);
  assert.equal(signal.aborted, false);
  assert.equal(manager.cancelIntent('new-hover'), true);
  assert.equal(signal.aborted, true);
  await tick();
});

test('Play intent cancellation cannot own or evict saved resume work', async () => {
  const manager = createPosterPreparation({ maximum: 1 });
  const saved = { status: 'ready' }, other = { status: 'ready' };
  let savedSignal;
  manager.start('saved', saved, async signal => { savedSignal = signal; }, async () => {});
  await tick();
  assert.equal(manager.start('saved', {}, async () => { assert.fail('saved work must be reused'); }, async () => {}, { intent: true, requestId: 'saved-hover' }), saved);
  assert.equal(manager.cancelIntent('saved-hover'), false);
  manager.start('other', other, async () => {}, async () => {}, { intent: true, requestId: 'other-hover' });
  assert.equal(savedSignal.aborted, false);
  assert.equal(manager.take('saved'), saved);
  assert.equal(manager.take('other'), other);
});

test('a saved resume adopting an intent is retained when a different Play target is hovered', async () => {
  const manager = createPosterPreparation();
  const job = { status: 'ready' };
  let signal;
  manager.start('adopted', job, async value => { signal = value; }, async () => {}, { intent: true, requestId: 'adopted-hover' });
  await tick();
  assert.equal(manager.start('adopted', {}, async () => {}, async () => {}), job);
  manager.start('other', { status: 'ready' }, async () => {}, async () => {}, { intent: true, requestId: 'other-hover' });
  assert.equal(manager.cancelIntent('adopted-hover'), false);
  assert.equal(signal.aborted, false);
  assert.equal(manager.take('adopted'), job);
  manager.cancel();
});

test('a cold Play intent can complete 23.8-second preparation and survive its old deadline after playback claims it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = createPosterPreparation();
  t.after(() => manager.cancel());
  const job = { status: 'selecting' };
  let signal, warmCalls = 0;
  manager.start('cold-movie', job, async value => {
    signal = value;
    await new Promise(resolve => setTimeout(resolve, 23800));
    value.throwIfAborted();
    job.status = 'ready';
  }, async () => { warmCalls++; }, { intent: true, requestId: 'cold-play' });
  t.mock.timers.tick(23800);
  await tick();
  assert.equal(signal.aborted, false, 'a measured cold start must not be killed by the old ten-second budget');
  assert.equal(job.status, 'ready');
  assert.equal(warmCalls, 1);
  assert.equal(manager.take('cold-movie'), job);
  t.mock.timers.tick(60000);
  assert.equal(signal.aborted, false, 'the unclaimed deadline must not cancel foreground ownership');
  assert.equal(manager.cancelIntent('cold-play'), false);
});

test('repeated Play starts reuse completed work without extending its bounded unclaimed lifetime', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = createPosterPreparation();
  t.after(() => manager.cancel());
  const job = { status: 'ready' };
  let signal, calls = 0;
  const prepare = async value => { signal = value; calls++; };
  manager.start('unclaimed', job, prepare, async () => {}, { intent: true, requestId: 'original-focus' });
  await tick();
  t.mock.timers.tick(29000);
  assert.equal(signal.aborted, false);
  assert.equal(manager.start('unclaimed', {}, prepare, async () => {}, { intent: true, requestId: 'repeated-focus' }), job);
  assert.equal(calls, 1, 'repeated focus must not start a second preparation');
  assert.equal(manager.cancelIntent('original-focus'), false);
  t.mock.timers.tick(1000);
  assert.equal(signal.aborted, true, 'a fresh token cannot renew the original work budget');
  assert.equal(manager.take('unclaimed'), null);
  assert.equal(manager.cancelIntent('repeated-focus'), false);
});

test('even completed new-title preparation expires at its configured intent budget', async () => {
  const manager = createPosterPreparation({ budgetMs: 1000, intentBudgetMs: 10 });
  let signal;
  manager.start('unused', { status: 'ready' }, async value => { signal = value; }, async () => {}, { intent: true, requestId: 'unused-hover' });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(signal.aborted, true);
  assert.equal(manager.cancelIntent('unused-hover'), false);
  assert.equal(manager.take('unused'), null);
});

test('abandonment arriving before POST registration prevents late provider work without disturbing a newer intent', async () => {
  const manager = createPosterPreparation();
  const current = { status: 'ready' };
  let currentSignal, calls = 0;
  assert.equal(manager.cancelIntent('abandoned-before-post'), false);
  manager.start('current', current, async signal => { currentSignal = signal; }, async () => {}, { intent: true, requestId: 'current-hover' });
  assert.equal(manager.start('late', { status: 'selecting' }, async () => { calls++; }, async () => {}, { intent: true, requestId: 'abandoned-before-post' }), null);
  assert.equal(calls, 0, 'cancelled POST must never enter release selection');
  assert.equal(currentSignal.aborted, false, 'late abandoned POST must not replace the current intent');
  assert.equal(manager.take('current'), current);
  await tick();
});

test('early-cancellation tombstones expire without affecting normal saved-resume preparation', async () => {
  const manager = createPosterPreparation({ intentCancellationTtlMs: 10 });
  const saved = { status: 'ready' }, later = { status: 'ready' };
  manager.cancelIntent('expired-hover');
  assert.equal(manager.start('saved', saved, async () => {}, async () => {}), saved);
  assert.equal(manager.take('saved'), saved);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(manager.start('later', later, async () => {}, async () => {}, { intent: true, requestId: 'expired-hover' }), later);
  assert.equal(manager.take('later'), later);
  await tick();
});

test('playback at a different position cancels both in-flight and warmed speculative preparation', async () => {
  for (const status of ['selecting', 'ready']) {
    const manager = createPosterPreparation();
    const job = { status, selectionStart: 0 };
    let preparationSignal, warmingSignal;
    const hold = signal => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    manager.start('episode', job, async signal => {
      preparationSignal = signal;
      if (status === 'selecting') await hold(signal);
    }, async signal => {
      warmingSignal = signal;
      await hold(signal);
    }, { intent: true, requestId: `position-${status}` });
    await tick();
    assert.equal(manager.take('episode', { start: 420 }), null);
    assert.equal(preparationSignal.aborted, true);
    if (status === 'ready') assert.equal(warmingSignal.aborted, true, 'a warm session at zero must not survive a resume handoff');
    assert.equal(manager.take('episode'), null);
    assert.equal(manager.cancelIntent(`position-${status}`), false);
    await tick();
  }
});

test('matching playback offsets retain ownership while take without an expected offset remains unchanged', async () => {
  const manager = createPosterPreparation();
  for (const [key, selectionStart, options] of [
    ['resume', 420, { start: '420' }],
    ['beginning', undefined, { start: 0 }],
    ['unspecified', 420, undefined]
  ]) {
    const job = { status: 'ready', selectionStart };
    let signal;
    manager.start(key, job, async value => { signal = value; }, async () => {}, { intent: true, requestId: `matching-${key}` });
    assert.equal(manager.take(key, options), job);
    assert.equal(signal.aborted, false);
    assert.equal(manager.cancelIntent(`matching-${key}`), false);
  }
  await tick();
});

test('claiming during validation preserves shared inspection and skips optional warming after it completes', async () => {
  const manager = createPosterPreparation(), inspections = createValidatedPreparationCache();
  const job = { status: 'ready', file: {} }, metadata = { duration: 7200 };
  let finishValidation, inspection, claimSignal, optionalWarmStarted = false;
  const validationGate = new Promise(resolve => { finishValidation = resolve; });
  manager.start('movie', job, async () => {}, async (signal, claimed, taken) => {
    claimSignal = taken;
    inspection = inspections.get(job.file, 'scope', async publish => {
      publish(metadata);
      await validationGate;
      signal.throwIfAborted();
      return metadata;
    }, signal);
    await inspection.validated;
    if (!claimed()) optionalWarmStarted = true;
  }, { intent: true, requestId: 'validating-click' });
  await tick();
  assert.equal(await inspection.metadata, metadata);
  assert.equal(manager.take('movie'), job);
  assert.equal(claimSignal.aborted, true);
  const foreground = inspections.get(job.file, 'scope', () => assert.fail('foreground must share the ongoing validation'));
  assert.equal(foreground, inspection);
  finishValidation();
  assert.equal(await foreground.validated, metadata);
  await tick();
  assert.equal(optionalWarmStarted, false);
  assert.equal(job.status, 'ready');
  assert.equal(inspections.get(job.file, 'scope', () => assert.fail('successful validation must remain reusable')), inspection);
});
