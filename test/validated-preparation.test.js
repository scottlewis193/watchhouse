import test from 'node:test';
import assert from 'node:assert/strict';
import { createValidatedPreparationCache } from '../src/lib/server/validated-preparation.js';

test('cancelled poster inspection cannot poison foreground playback or delete a replacement probe', async () => {
  const cache = createValidatedPreparationCache(), source = {}, controller = new AbortController();
  let failOld, calls = 0;
  const old = cache.get(source, 'policy', async publish => {
    publish('old');
    await new Promise((_resolve, reject) => { failOld = reject; });
  }, controller.signal);
  await old.metadata; controller.abort();
  const inspect = async publish => { calls++; publish('new'); return 'new'; };
  const current = cache.get(source, 'policy', inspect);
  assert.equal(await current.metadata, 'new');
  assert.equal(await current.validated, 'new');
  failOld(new Error('cancelled')); await assert.rejects(old.validated);
  assert.equal(await cache.get(source, 'policy', inspect).metadata, 'new');
  assert.equal(calls, 1);
});
