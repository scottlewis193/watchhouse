import test from 'node:test';
import assert from 'node:assert/strict';
import { openArchiveByteInput } from '../src/lib/server/streamer.js';

const articleBytes = 256 * 1024;
const articleCount = 48;
const files = [{ subject: 'movie.rar', segments: Array.from({ length: articleCount }, (_, index) => ({ id: String(index), number: index + 1 })) }];

function openInput({ reads = new Map(), provider = 'first', salt = 0, beforeBody = async () => {} } = {}) {
  return openArchiveByteInput(files, { maxConnections: 4, usenetHost: provider }, async () => ({
    close() {},
    async body(id, line) {
      const index = Number(id), begin = index * articleBytes;
      reads.set(index, (reads.get(index) || 0) + 1);
      await beforeBody(index);
      await line(`=ybegin size=${articleBytes * articleCount} name=movie.rar`);
      await line(`=ypart begin=${begin + 1} end=${begin + articleBytes}`);
      await line(String.fromCharCode(65 + index % 16 + salt).repeat(articleBytes));
      await line(`=yend size=${articleBytes}`);
    }
  }));
}

test('archive playback reuses validated opening bytes after a larger metadata scan evicts the local range cache', async () => {
  const reads = new Map(), input = await openInput({ reads });
  try {
    const start = articleBytes, end = start * 2 - 1;
    const opening = await input.read(start, end);
    assert.deepEqual(opening, Buffer.alloc(articleBytes, 24));
    const scan = await input.read(articleBytes * 2, input.size - 1);
    assert.equal(scan[0], 25);
    assert.equal(scan.at(-1), 38);
    assert.deepEqual(await input.read(start, end), opening);
    assert.equal(reads.get(1), 1, 'starting playback must not redownload opening articles already validated by probing');
  } finally { await input.close(); }
});

test('archive byte reuse cannot leak a previous provider input into another source with the same article IDs', async () => {
  const first = await openInput();
  let second;
  try {
    assert.deepEqual(await first.read(articleBytes, articleBytes * 2 - 1), Buffer.alloc(articleBytes, 24));
    second = await openInput({ provider: 'second', salt: 1 });
    assert.deepEqual(await second.read(articleBytes, articleBytes * 2 - 1), Buffer.alloc(articleBytes, 25));
  } finally {
    await first.close();
    await second?.close();
  }
});

test('cached encoder bytes bypass an abandoned metadata range still draining from the provider', { timeout: 5000 }, async () => {
  let started, release, input, abandoned, timer;
  const reading = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  try {
    input = await openInput({ beforeBody: async index => { if (index === 10) { started(); await held; } } });
    const opening = await input.read(articleBytes, articleBytes * 2 - 1);
    abandoned = input.read(articleBytes * 10, articleBytes * 11 - 1, controller.signal);
    void abandoned.catch(() => {});
    await reading;
    controller.abort(new Error('Metadata reader finished'));
    const seek = input.read(articleBytes, articleBytes * 2 - 1);
    const bytes = await Promise.race([seek, new Promise(resolve => { timer = setTimeout(() => resolve(null), 250); })]);
    assert.ok(bytes, 'cached bytes must be available while the abandoned provider read is held');
    assert.deepEqual(bytes, opening, 'already validated bytes must not wait for unrelated provider traffic');
  } finally {
    clearTimeout(timer); release(); await abandoned?.catch(() => {}); await input?.close();
  }
});
