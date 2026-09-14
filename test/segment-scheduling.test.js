import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostedSegmentLoader } from '../src/lib/server/streamer.js';

test('a slow article does not block a later request when another connection is idle', async () => {
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const file = { segments: [0, 1, 2].map(id => ({ id: String(id), decodedBytes: 1 })) };
  const loader = createPostedSegmentLoader(file, { maxConnections: 2 }, new Map(), async () => ({
    async body(id, line) { if (id === '0') await blocked; await line('k'); }, close() {}
  }));
  const first = loader.load(file.segments[0], 0);
  let timer;
  try {
    await loader.load(file.segments[1], 1);
    const third = loader.load(file.segments[2], 2);
    const completed = await Promise.race([third.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 200); })]);
    assert.equal(completed, true, 'an idle connection must serve the new range instead of queuing behind the blocked article');
  } finally { clearTimeout(timer); unblock(); await first; await loader.close(); }
});
