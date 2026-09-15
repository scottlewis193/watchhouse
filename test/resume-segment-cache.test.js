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

test('resume byte cache clears one source without evicting another', async () => {
  const { createSegmentCache } = await import('../src/lib/server/segment-cache.js');
  const cache = createSegmentCache(8), first = {}, second = {};
  cache.set(first, 0, Buffer.from('AAAA'));
  cache.set(second, 0, Buffer.from('BBBB'));
  cache.delete(first);
  assert.equal(cache.get(first, 0), undefined);
  assert.equal(cache.get(second, 0).toString(), 'BBBB');
});

test('overlapping playback sessions share an article that is still downloading', async () => {
  let reads = 0, release, firstRead;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { firstRead = resolve; });
  const file = { subject: 'movie.mp4', segments: [{ id: 'one', decodedBytes: 4 }] };
  const connect = async () => ({ async body(_id, line) { reads++; firstRead(); await gate; await line('klmn'); }, close() {} });
  const sources = await Promise.all([openPostedRangeServer({ file }, {}, connect), openPostedRangeServer({ file }, {}, connect)]);
  const replies = sources.map(source => fetch(source.url).then(reply => reply.text()));
  try {
    await started;
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    assert.deepEqual(await Promise.all(replies), ['ABCD', 'ABCD']);
    assert.equal(reads, 1, 'overlapping setup requests must not download the same article twice');
  } finally { release(); await Promise.allSettled(replies); await Promise.all(sources.map(source => source.close())); }
});

test('a failed shared download does not poison subsequent playback', async () => {
  const { createSegmentCache } = await import('../src/lib/server/segment-cache.js');
  const cache = createSegmentCache(8), source = {};
  let calls = 0;
  const failed = () => { calls++; throw new Error('temporary'); };
  const results = await Promise.allSettled([cache.load(source, 0, failed), cache.load(source, 0, failed)]);
  assert.equal(calls, 1);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal((await cache.load(source, 0, () => Buffer.from('OK'))).toString(), 'OK');
  assert.equal((await cache.load(source, 0, failed)).toString(), 'OK');
  assert.equal(calls, 1);
});

test('an abandoned range cannot queue a seek behind several batches of unnecessary articles', async () => {
  let releaseFirst, releaseLater, tailStarted;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const later = new Promise(resolve => { releaseLater = resolve; });
  const tail = new Promise(resolve => { tailStarted = resolve; });
  let reads = 0;
  const file = { subject: 'movie.mp4', segments: Array.from({ length: 60 }, (_, index) => ({ id: String(index), decodedBytes: 4 })) };
  const source = await openPostedRangeServer({ file, prefetchedSegments: new Map([[0, Buffer.from('ABCD')]]) }, { maxConnections: 50 }, async () => ({
    async body(id, line) {
      if (id === '59') tailStarted();
      else await (++reads <= 12 ? first : later);
      await line('klmn');
    }, close() {}
  }));
  let requestedTail, timer;
  try {
    const response = await fetch(source.url, { headers: { range: 'bytes=0-239' } });
    const reader = response.body.getReader();
    assert.equal(Buffer.from((await reader.read()).value).toString(), 'ABCD');
    await reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 25));
    requestedTail = fetch(source.url, { headers: { range: 'bytes=236-239' } }).then(reply => reply.text());
    await new Promise(resolve => setTimeout(resolve, 25));
    releaseFirst();
    assert.equal(await Promise.race([tail.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 200); })]), true, 'the seek must run after the active batch, without waiting behind abandoned read-ahead');
    assert.equal(await requestedTail, 'ABCD');
  } finally { clearTimeout(timer); releaseFirst(); releaseLater(); await requestedTail; await source.close(); }
});
