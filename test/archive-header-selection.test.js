import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveHeaderReadiness, openArchiveByteInput, preparePlayback, createPlaybackPlanCache } from '../src/lib/server/streamer.js';
import { createReleaseHealthStore } from '../src/lib/server/release-health.js';

function header(type, flags, data) {
  const bytes = Buffer.alloc(7 + data.length);
  bytes[2] = type; bytes.writeUInt16LE(flags, 3); bytes.writeUInt16LE(bytes.length, 5); data.copy(bytes, 7);
  bytes.writeUInt16LE(crc32(bytes.subarray(2)) & 65535);
  return bytes;
}
function rar(salt = 0, encrypted = false) {
  const name = Buffer.from('film.mkv'), body = Buffer.alloc(25 + name.length);
  body.writeUInt32LE(1000); body.writeUInt32LE(1000, 4); body[17] = 20; body[18] = 0x30;
  body.writeUInt16LE(name.length, 19); name.copy(body, 25);
  return Buffer.concat([Buffer.from('526172211a0700', 'hex'), header(0x73, 0, Buffer.alloc(6)), header(0x74, 0x8000 | (encrypted ? 4 : 0), body), Buffer.alloc(1000, salt)]);
}
function encoded(bytes) {
  let line = '';
  for (const byte of bytes) { const v = (byte + 42) & 255; line += [0, 10, 13, 61].includes(v) ? '=' + String.fromCharCode((v + 64) & 255) : String.fromCharCode(v); }
  return line;
}
function provider(bytes, counter) {
  return async settings => ({ close() {}, async body(id, line) {
    settings.signal?.throwIfAborted(); counter.count++;
    await line(`=ybegin size=${bytes.length} name=film.rar`);
    await line(encoded(bytes)); await line(`=yend size=${bytes.length}`);
  } });
}

test('archive header lookahead hands its validated first article to foreground opening without downloading it again', async () => {
  const bytes = rar(17), count = { count: 0 }, files = [{ subject: 'film.rar', segments: [{ id: 'first' }] }];
  const settings = { usenetHost: 'provider', maxConnections: 50 }, connect = provider(bytes, count);
  const result = await archiveHeaderReadiness(files, settings, connect);
  assert.equal(result.kind, 'stored');
  const input = await openArchiveByteInput(files, settings, connect, () => {}, result.header);
  try {
    assert.deepEqual(await input.read(0, bytes.length - 1), bytes);
    assert.equal(count.count, 1);
  } finally { await input.close(); }
});

test('archive lookahead bodies cannot be reused after provider credentials change', async () => {
  const files = [{ subject: 'film.rar', segments: [{ id: 'same-id' }] }], count = { count: 0 };
  const settings = { usenetHost: 'provider', usenetPass: 'old', maxConnections: 1 };
  const result = await archiveHeaderReadiness(files, settings, provider(rar(1), count));
  const next = rar(2);
  const input = await openArchiveByteInput(files, { ...settings, usenetPass: 'new' }, provider(next, count), () => {}, result.header);
  try {
    assert.deepEqual(await input.read(0, next.length - 1), next);
    assert.equal(count.count, 2);
    assert.equal(input.headerConcurrency, 1);
  } finally { await input.close(); }
});

test('confirmed encryption is rejected during header lookahead', async () => {
  const files = [{ subject: 'film.rar', segments: [{ id: 'encrypted' }] }];
  await assert.rejects(archiveHeaderReadiness(files, {}, provider(rar(0, true), { count: 0 })), { code: 'ARCHIVE_ENCRYPTED' });
});

const media = { type: 'movie', id: 1, title: 'Film', year: '2024' };
const nzb = (name, id) => `<nzb><file subject="${name}"><segments><segment number="1">${id}</segment></segments></file></nzb>`;
const release = label => ({ title: `Film.2024.1080p.${label}` });

for (const code of ['ARCHIVE_ENCRYPTED', 'ARCHIVE_UNSUPPORTED']) {
  test(`${code} cooldown skips duplicate article sets and survives a new selection`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'archive-header-health-'));
    const settings = { usenetHost: 'provider', usenetPass: 'secret', maxConnections: 4 };
    const choices = [release('First'), release('Duplicate'), release('Healthy')];
    const checked = [], opened = [];
    const options = health => ({
      search: async () => choices,
      load: async candidate => nzb('film.rar', candidate === choices[2] ? 'healthy' : 'same-bad-articles'),
      check: async () => null, archiveCheck: null,
      archiveHeader: async files => { const id = files[0].segments[0].id; checked.push(id); if (id !== 'healthy') throw Object.assign(new Error(code), { code }); return { kind: 'stored' }; },
      progressive: async job => { opened.push(job.release); return true; },
      health, plans: createPlaybackPlanCache()
    });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const health = createReleaseHealthStore(join(root, 'health.json'));
        const job = { media, events: [] };
        await preparePlayback(job, settings, options(health));
        assert.equal(job.status, 'ready');
        assert.equal(job.release, choices[2].title);
        assert.equal((await health.get(settings, media, choices[0].title)).reason, code);
      }
      assert.deepEqual(checked, ['same-bad-articles', 'healthy', 'healthy']);
      assert.deepEqual(opened, [choices[2].title, choices[2].title]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const manual of [false, true]) {
  test(`actual NZB readiness respects ${manual ? 'manual release order' : 'equivalent automatic preferences'}`, async () => {
    const choices = [release('Archive'), release('Direct')], opened = [], job = { media, events: [] };
    let checkedDirect;
    const directReady = new Promise(resolve => { checkedDirect = resolve; });
    await preparePlayback(job, { maxConnections: 4, manualReleaseSelection: manual }, {
      search: async () => choices,
      load: async candidate => nzb(candidate === choices[0] ? 'film.rar' : 'film.mkv', candidate.title),
      check: async () => { checkedDirect(); return Buffer.from('validated media'); },
      archiveCheck: null,
      archiveHeader: async () => { await directReady; await new Promise(resolve => setImmediate(resolve)); return { kind: 'stored' }; },
      progressive: async candidate => { opened.push(candidate.release); return true; },
      health: { has: async () => false, reject: async () => {} }, plans: createPlaybackPlanCache()
    });
    assert.equal(job.status, 'ready');
    assert.equal(job.release, choices[manual ? 0 : 1].title);
    assert.deepEqual(opened, manual ? [choices[0].title] : []);
  });
}

test('an inconclusive header timeout does not blacklist an otherwise playable archive', async () => {
  const job = { media, events: [] };
  await preparePlayback(job, { maxConnections: 4 }, {
    search: async () => [release('Healthy')], load: async () => nzb('film.rar', 'healthy'), check: async () => null,
    archiveHeader: async () => { throw Object.assign(new Error('Temporary timeout'), { code: 'ETIMEDOUT' }); }, archiveCheck: null,
    progressive: async () => true, health: { has: async () => false, reject: async () => assert.fail('A timeout must remain inconclusive') }, plans: createPlaybackPlanCache()
  });
  assert.equal(job.status, 'ready');
});

test('a missing volume header immediately cancels other reads and preserves the provider error', { timeout: 5000 }, async () => {
  const bytes = rar(0), missing = Object.assign(new Error('Required header article is missing'), { code: 'USENET_ARTICLE_MISSING' });
  const files = Array.from({ length: 4 }, (_, index) => ({ subject: `film.part${index + 1}.rar`, segments: [{ id: String(index), number: 1 }] }));
  let reading, timer, input, pending;
  const started = new Promise(resolve => { reading = resolve; });
  const connect = async settings => ({ close() {}, async body(id, line) {
    if (id === '1') throw missing;
    if (id === '2') {
      reading();
      await new Promise((_resolve, reject) => settings.signal.addEventListener('abort', () => reject(settings.signal.reason), { once: true }));
    }
    await line(`=ybegin size=${bytes.length} name=film.rar`);
    await line(encoded(bytes)); await line(`=yend size=${bytes.length}`);
  } });
  try {
    input = await openArchiveByteInput(files, { maxConnections: 50 }, connect);
    const slow = input.readVolumeHeader(2, 64); void slow.catch(() => {});
    await started;
    pending = Promise.allSettled([input.readVolumeHeader(1, 64), slow]);
    const results = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), 250); })]);
    assert.ok(results, 'a known failed source must not keep draining unrelated header bodies');
    assert.ok(results.every(result => result.status === 'rejected' && result.reason === missing));
    await assert.rejects(input.read(0, 1), error => error === missing);
  } finally { clearTimeout(timer); await input?.close(); await pending; }
});
