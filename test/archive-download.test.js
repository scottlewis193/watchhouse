import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { cancelDownloadJob } from '../src/lib/server/download-cancellation.js';
import { downloadPostedFiles } from '../src/lib/server/archive-download.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writePostedFiles } from '../src/lib/server/streamer.js';

const execute = promisify(execFile);

test('archive workers cross volume boundaries while an earlier article is still downloading', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'archive-queue-'));
  let releaseFirst, secondStarted = false;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const connect = async () => ({ close() {}, async body(id, line) {
    if (id === 'first') await first; else secondStarted = true;
    await line(String.fromCharCode((id === 'first' ? 65 : 66) + 42));
  } });
  const files = ['first', 'second'].map(id => ({ path: join(directory, id), posted: { segments: [{ id }] } }));
  const state = { completed: 0, bytes: 0, total: 2, started: Date.now() };
  const download = writePostedFiles(files, { maxConnections: 2 }, {}, state, 85, connect);
  try {
    await delay(50);
    const overlapped = secondStarted;
    releaseFirst();
    await download;
    assert.equal(overlapped, true, 'the next volume must use the otherwise idle worker');
    assert.equal((await readFile(files[0].path)).toString(), 'A');
    assert.equal((await readFile(files[1].path)).toString(), 'B');
    assert.equal(state.completed, 2);
  } finally { releaseFirst(); await download.catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});


async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'archive-download-'));
  const files = ['one', 'two'].map(id => ({ path: join(directory, id), posted: { segments: [{ id: `${id}-0` }, { id: `${id}-1` }] } }));
  const state = { completed: 0, bytes: 0, total: 4, started: Date.now() };
  try { await run({ directory, files, state }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const decode = line => Buffer.from(line);

test('assembly cannot hold up network workers, and background work stays serial', async () => {
  await fixture(async ({ files, state }) => {
    let finishAssembly, startedAssembly, finishedSecond;
    const held = new Promise(resolve => { finishAssembly = resolve; });
    const started = new Promise(resolve => { startedAssembly = resolve; });
    const second = new Promise(resolve => { finishedSecond = resolve; });
    let active = 0, peak = 0;
    const download = downloadPostedFiles(files, { maxConnections: 50, backgroundJob: {} }, {}, state, {
      decode,
      connect: async () => ({ close() {}, async body(id, line) {
        active++; peak = Math.max(peak, active); await line(id); active--;
        if (id === 'two-1') finishedSecond();
      } }),
      assemble: async volume => { if (volume.path === files[0].path) { startedAssembly(); await held; } }
    });
    try {
      await started;
      await Promise.race([second, delay(500).then(() => { throw new Error('Network waited for assembly'); })]);
      assert.equal(peak, 1);
    } finally { finishAssembly(); await download; }
  });
});

test('out-of-order articles and batched disk writes preserve exact volume bytes', async () => {
  await fixture(async ({ files, state }) => {
    const payload = id => `${id}:` + 'x'.repeat(150000);
    await downloadPostedFiles(files, { maxConnections: 3 }, {}, state, {
      decode,
      connect: async () => ({ close() {}, async body(id, line) {
        if (id.endsWith('0')) await delay(10);
        const data = payload(id);
        for (let i = 0; i < data.length; i += 128) await line(data.slice(i, i + 128));
      } })
    });
    for (const file of files) assert.equal((await readFile(file.path)).toString(), file.posted.segments.map(s => payload(s.id)).join(''));
    assert.equal(state.completed, 4);
    assert.equal(state.bytes, files.flatMap(f => f.posted.segments).reduce((sum, s) => sum + Buffer.byteLength(payload(s.id)), 0));
  });
});

test('completed articles resume without refetching, while stale pending bytes are replaced', async () => {
  await fixture(async ({ files, state }) => {
    await mkdir(`${files[0].path}.parts`);
    await writeFile(`${files[0].path}.parts/000000`, 'saved');
    await writeFile(`${files[0].path}.parts/000001.pending`, 'broken partial bytes');
    const fetched = [];
    await downloadPostedFiles(files, { maxConnections: 2 }, {}, state, { decode, connect: async () => ({ close() {}, async body(id, line) { fetched.push(id); await line(id); } }) });
    assert.equal(fetched.includes('one-0'), false);
    assert.equal((await readFile(files[0].path)).toString(), 'savedone-1');
    assert.equal(state.completed, 4);
  });
});

test('cancellation joins every worker before returning and never publishes partial volumes', async () => {
  await fixture(async ({ directory, files, state }) => {
    const job = { status: 'downloading' };
    let reads = 0, notify;
    const started = new Promise(resolve => { notify = resolve; });
    const download = downloadPostedFiles(files, { maxConnections: 2 }, job, state, { decode, connect: async () => {
      let reject;
      return { close() { reject?.(new Error('closed')); }, async body(id, line) {
        await line('partial');
        return new Promise((resolve, failed) => { reject = failed; if (++reads === 2) notify(); });
      } };
    } });
    await started; cancelDownloadJob(job);
    await assert.rejects(download, { code: 'DOWNLOAD_CANCELLED' });
    for (const file of files) {
      await assert.rejects(readFile(file.path), { code: 'ENOENT' });
      assert.deepEqual(await readdir(`${file.path}.parts`), []);
    }
    assert.equal(reads, 2);
    assert.equal((await readdir(directory)).some(name => name.endsWith('.assembling')), false);
  });
});

test('an assembly error aborts the download instead of leaving network workers running', async () => {
  await fixture(async ({ files, state }) => {
    let closed = 0;
    await assert.rejects(downloadPostedFiles(files, { maxConnections: 1 }, {}, state, {
      decode, assemble: async () => { throw new Error('disk full'); },
      connect: async () => ({ close() { closed++; }, async body(id, line) { await line(id); } })
    }), /disk full/);
    assert.ok(closed > 0);
  });
});


test('downloaded split 7z volumes extract to the original video bytes', async () => {
  await fixture(async ({ directory }) => {
    const source = join(directory, 'video.mkv');
    const bytes = Buffer.alloc(300000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) & 255;
    await writeFile(source, bytes);
    const archive = join(directory, 'fixture.7z');
    await execute('7z', ['a', '-t7z', '-mx=0', '-v64k', archive, source]);
    const names = (await readdir(directory)).filter(name => name.startsWith('fixture.7z.')).sort();
    const destination = join(directory, 'downloaded'); await mkdir(destination);
    const articles = new Map();
    const files = [];
    for (const name of names.reverse()) {
      const data = await readFile(join(directory, name)), segments = [];
      for (let offset = 0; offset < data.length; offset += 8192) {
        const id = `${name}-${offset}`; segments.push({ id }); articles.set(id, data.subarray(offset, offset + 8192));
      }
      files.push({ path: join(destination, name), posted: { segments } });
    }
    const state = { completed: 0, bytes: 0 };
    await downloadPostedFiles(files, { maxConnections: 4 }, {}, state, {
      decode: line => Buffer.from(line, 'base64'),
      connect: async () => ({ close() {}, async body(id, line) { await line(articles.get(id).toString('base64')); } })
    });
    await execute('7z', ['x', '-y', join(destination, 'fixture.7z.001'), `-o${join(directory, 'extracted')}`]);
    assert.deepEqual(await readFile(join(directory, 'extracted', 'video.mkv')), bytes);
  });
});

test('a missing article closes peer readers and retains only completed retry parts', async () => {
  await fixture(async ({ files, state }) => {
    let peerStarted, rejectPeer, closes = 0;
    const peer = new Promise(resolve => { peerStarted = resolve; });
    await assert.rejects(downloadPostedFiles(files, { maxConnections: 2 }, {}, state, { decode, connect: async () => ({
      close() { closes++; rejectPeer?.(new Error('peer closed')); },
      async body(id, line) {
        if (id === 'one-0') { await peer; throw Object.assign(new Error('missing'), { code: 'USENET_ARTICLE_MISSING' }); }
        await line('partial');
        return new Promise((resolve, reject) => { rejectPeer = reject; peerStarted(); });
      }
    }) }), { code: 'USENET_ARTICLE_MISSING' });
    assert.ok(closes >= 2);
    for (const file of files) {
      await assert.rejects(readFile(file.path), { code: 'ENOENT' });
      assert.deepEqual(await readdir(`${file.path}.parts`), []);
    }
  });
});

test('duplicate normalized volume names cannot schedule concurrent writes to the same file', async () => {
  await fixture(async ({ files, state }) => {
    const requested = [];
    await downloadPostedFiles([files[0], { ...files[1], path: files[0].path }], { maxConnections: 4 }, {}, state, {
      decode, connect: async () => ({ close() {}, async body(id, line) { requested.push(id); await line(id); } })
    });
    assert.deepEqual(requested.sort(), ['one-0', 'one-1']);
    assert.equal((await readFile(files[0].path)).toString(), 'one-0one-1');
  });
});
