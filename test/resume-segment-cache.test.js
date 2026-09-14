import test from 'node:test';
import assert from 'node:assert/strict';
import { openPostedRangeServer } from '../src/lib/server/streamer.js';

test('a new playback session reuses validated bytes from the same source', async () => {
  let reads = 0;
  const file = { subject: 'movie.mp4', segments: [{ id: 'one', decodedBytes: 4 }] };
  const connect = async () => ({ async body(_id, line) { reads++; await line('klmn'); }, close() {} });
  for (let attempt = 0; attempt < 2; attempt++) {
    const source = await openPostedRangeServer({ file }, {}, connect);
    try { assert.equal(await (await fetch(source.url)).text(), 'ABCD'); }
    finally { await source.close(); }
  }
  assert.equal(reads, 1, 'resuming must not download the same article again');
  const replacement = await openPostedRangeServer({ file: { ...file } }, {}, connect);
  try { assert.equal(await (await fetch(replacement.url)).text(), 'ABCD'); }
  finally { await replacement.close(); }
  assert.equal(reads, 2, 'a newly selected source must be validated independently');
});

test('resume byte cache evicts least recently used entries across sources within its byte budget', async () => {
  const { createSegmentCache } = await import('../src/lib/server/segment-cache.js');
  const cache = createSegmentCache(8), first = {}, second = {};
  cache.set(first, 0, Buffer.from('AAAA'));
  cache.set(second, 0, Buffer.from('BBBB'));
  assert.equal(cache.get(first, 0).toString(), 'AAAA');
  cache.set(first, 1, Buffer.from('CCCC'));
  assert.equal(cache.get(second, 0), undefined);
  cache.set(first, 0, Buffer.from('DD'));
  cache.set(second, 1, Buffer.from('EE'));
  assert.equal(cache.get(first, 1).toString(), 'CCCC');
  cache.set(second, 2, Buffer.alloc(9));
  assert.equal(cache.get(second, 2), undefined);
  assert.equal(cache.get(first, 0).toString(), 'DD');
});
