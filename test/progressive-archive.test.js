import { crc32 } from 'node:zlib';
import { createHlsSession } from '../src/lib/server/hls-session.js';
import { progressiveArchiveVolumes, openArchiveByteInput, startHlsConversion, preparePlayback, createPlaybackPlanCache } from '../src/lib/server/streamer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createProgressiveArchiveSource, archiveByteRange } from '../src/lib/server/progressive-archive.js';
import { inspectStoredRar, tryCreateStoredRarSource } from '../src/lib/server/stored-rar-source.js';
const execute = promisify(execFile);

test('7z video bytes are playable before the middle of the archive arrives', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'progressive-7z-'));
  let source, unblock;
  const held = new Promise(resolve => { unblock = resolve; });
  try {
    const video = randomBytes(12 * 1024 * 1024);
    await writeFile(join(root, 'video.mkv'), video);
    await execute('7z', ['a', '-t7z', '-mx=0', join(root, 'video.7z'), join(root, 'video.mkv')]);
    const archive = await readFile(join(root, 'video.7z'));
    let middleRequested = false;
    source = await createProgressiveArchiveSource({ size: archive.length, close: async () => {}, async read(start, end) {
      if (start >= 4 * 1024 * 1024 && start < 8 * 1024 * 1024) { middleRequested = true; await held; }
      return archive.subarray(start, end + 1);
    } }, { root, archiveReadBytes: 8 * 1024 * 1024 });
    const lease = source.retain();
    const response = await fetch(lease.url, { headers: { Range: 'bytes=0-65535' } });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(0, 65536));
    assert.equal(source.complete, false);
    assert.ok(source.available < video.length);
    unblock(); await source.completion;
    const tail = await fetch(lease.url, { headers: { Range: 'bytes=-100' } });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), video.subarray(-100));
    assert.equal(middleRequested, true);
    lease.close();
  } finally { unblock(); await source?.close(); await rm(root, { recursive: true, force: true }); }
});

test('archive range parsing rejects malformed requests and supports suffixes', () => {
  assert.deepEqual(archiveByteRange('bytes=-3', 10), { start: 7, end: 9, partial: true });
  for (const value of ['bytes=10-', 'bytes=8-2', 'bytes=-0', 'bytes=0-1,3-4']) assert.equal(archiveByteRange(value, 10), null);
});

test('archive extraction uses a 16 MB upstream batch for deep resumes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'progressive-read-window-'));
  const helper = join(root, 'helper.py'), reads = [];
  let source;
  try {
    await writeFile(helper, `import json, sys, urllib.request\nurl, output, total, window = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])\nrequest = urllib.request.Request(url, headers={'Range': f'bytes=0-{window - 1}'})\nwith urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request) as response:\n    payload = response.read()\nwith open(output, 'wb') as target:\n    target.write(payload)\nprint(json.dumps({'type': 'metadata', 'name': 'video.mkv', 'size': len(payload)}), flush=True)\nprint(json.dumps({'type': 'complete', 'bytes': len(payload)}), flush=True)\n`);
    source = await createProgressiveArchiveSource({
      size: 32 * 1024 * 1024,
      close: async () => {},
      async read(start, end) { reads.push([start, end]); return Buffer.alloc(end - start + 1); }
    }, { root, helper });
    assert.equal(source.complete, true);
    assert.deepEqual(reads, [[0, 16 * 1024 * 1024 - 1]], 'small sequential reads add provider round trips before a deep resume');
  } finally { await source?.close(); await rm(root, { recursive: true, force: true }); }
});


test('archive volume ordering is numeric and rejects mixed or incomplete sets', () => {
  const file = subject => ({ subject, segments: [{ id: 'part' }] });
  const ordered = [file('movie.7z.003'), file('movie.7z.001'), file('movie.7z.002')];
  assert.deepEqual(progressiveArchiveVolumes(ordered).map(f => f.subject), ['movie.7z.001', 'movie.7z.002', 'movie.7z.003']);
  assert.equal(progressiveArchiveVolumes([file('movie.7z.001'), file('movie.7z.003')]), null);
  assert.equal(progressiveArchiveVolumes([file('one.7z.001'), file('two.7z.002')]), null);
  assert.deepEqual(progressiveArchiveVolumes([file('movie.r01'), file('movie.rar'), file('movie.r00')]).map(f => f.subject), ['movie.rar', 'movie.r00', 'movie.r01']);
});

function encoded(bytes) {
  let line = '';
  for (const byte of bytes) { const value = (byte + 42) & 255; line += [0, 10, 13, 61].includes(value) ? '=' + String.fromCharCode((value + 64) & 255) : String.fromCharCode(value); }
  return line;
}

test('virtual split-archive ranges map correctly across yEnc volume boundaries', async () => {
  const payloads = [Buffer.from('abcdefghijkl'), Buffer.from('mnopqrstuvwx'), Buffer.from('yz!')];
  const files = payloads.map((data, volume) => ({ subject: `movie.7z.00${volume + 1}`, segments: Array.from({ length: Math.ceil(data.length / 4) }, (_, index) => ({ id: `${volume}:${index}` })) }));
  const input = await openArchiveByteInput(files.toReversed(), { maxConnections: 2 }, async () => ({ close() {}, async body(id, line) {
    const [volume, index] = id.split(':').map(Number), data = payloads[volume], begin = index * 4, chunk = data.subarray(begin, begin + 4);
    await line(`=ybegin size=${data.length} name=movie.7z.00${volume + 1}`);
    await line(`=ypart begin=${begin + 1} end=${begin + chunk.length}`);
    await line(encoded(chunk)); await line(`=yend size=${chunk.length}`);
  } }));
  try {
    assert.equal(input.size, 27);
    assert.equal((await input.read(10, 25)).toString(), 'klmnopqrstuvwxyz');
  } finally { await input.close(); }
});

test('a later missing archive article reports the failed source for replacement', async () => {
  const data = Buffer.from('abcdefghijkl');
  const files = [{ subject: 'movie.7z.001', segments: Array.from({ length: 3 }, (_, index) => ({ id: String(index) })) }];
  const errors = [];
  const input = await openArchiveByteInput(files, { maxConnections: 1 }, async () => ({ close() {}, async body(id, line) {
    if (id === '1') throw Object.assign(new Error('430 No Such Article'), { code: 'USENET_ARTICLE_MISSING' });
    const begin = Number(id) * 4, chunk = data.subarray(begin, begin + 4);
    await line(`=ybegin size=${data.length} name=movie.7z.001`);
    await line(`=ypart begin=${begin + 1} end=${begin + chunk.length}`);
    await line(encoded(chunk)); await line(`=yend size=${chunk.length}`);
  } }), error => errors.push(error.code));
  try {
    await assert.rejects(input.read(4, 7), { code: 'USENET_ARTICLE_MISSING' });
    assert.deepEqual(errors, ['USENET_ARTICLE_MISSING']);
  } finally { await input.close(); }
});

test('encrypted 7z headers fail promptly and leave no extraction directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'encrypted-7z-'));
  try {
    await writeFile(join(root, 'video.mkv'), 'video');
    await execute('7z', ['a', '-t7z', '-pfixture', '-mhe=on', join(root, 'secret.7z'), join(root, 'video.mkv')]);
    const bytes = await readFile(join(root, 'secret.7z'));
    let closed = false;
    await assert.rejects(createProgressiveArchiveSource({ size: bytes.length, read: async (start, end) => bytes.subarray(start, end + 1), close: async () => { closed = true; } }, { root }), /encrypt/i);
    assert.equal(closed, true);
    assert.equal((await readdir(root)).some(name => name.startsWith('playback-progressive-')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('HLS passes real opening timeline validation and produces segments before archive extraction finishes', { timeout: 40000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-hls-'));
  let source, session, unblock;
  const held = new Promise(resolve => { unblock = resolve; });
  try {
    const videoPath = join(root, 'video.mkv');
    await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '180', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', videoPath]);
    await execute('7z', ['a', '-t7z', '-mx=0', join(root, 'video.7z'), videoPath]);
    const archive = await readFile(join(root, 'video.7z'));
    assert.ok(archive.length > 8 * 1024 * 1024);
    // Keep a provider range unavailable even when the default read window grows.
    source = await createProgressiveArchiveSource({ size: archive.length, close: async () => {}, async read(start, end) {
      if (start >= archive.length * 0.7 && end < archive.length - 65536) await held;
      return archive.subarray(start, end + 1);
    } }, { root, archiveReadBytes: 8 * 1024 * 1024 });
    const job = { media: { type: 'tv', id: 999999, season: 1, episode: 1 }, progressiveArchive: true, archiveSource: source, file: { subject: 'video.mkv' }, release: 'Fixture SDR H264', strategy: 'remux', mode: 'direct', diagnosticsEnabled: true, events: [] };
    const startup = Date.now();
    session = await createHlsSession({ root, produce: directory => startHlsConversion(job, {}, 0, directory) });
    await session.ready();
    assert.ok(Date.now() - startup < 8000, 'probing must not wait for the 15-second tail-seek timeout');
    assert.equal(source.complete, false, 'first HLS segments must not require the entire extracted video');
    const seeking = source.retain({ forwardSeek: true });
    try {
      const response = await fetch(seeking.url, { headers: { Range: 'bytes=0-65535' } });
      const edited = Buffer.from(await response.arrayBuffer());
      const original = (await readFile(videoPath)).subarray(0, 65536);
      assert.equal(edited.length, original.length);
      assert.notDeepEqual(edited, original, 'the seek view hides SeekHead without changing offsets');
      const ordinary = source.retain();
      try {
        const plain = Buffer.from(await (await fetch(ordinary.url, { headers: { Range: 'bytes=0-65535' } })).arrayBuffer());
        assert.deepEqual(plain, original, 'normal playback still receives original container bytes');
      } finally { ordinary.close(); }
    } finally { seeking.close(); }
    assert.ok(job.events.some(event => event.activity === 'timeline-validated'));
    assert.ok((await session.read('index.m3u8')).toString().includes('segment-000000.m4s'));
    await session.close();
    const reopened = { media: job.media, diagnosticsEnabled: true, events: [] };
    await preparePlayback(reopened, {}, {
      plans: createPlaybackPlanCache(), health: { has: async () => false },
      search: async () => { throw new Error('Resume searched instead of reusing the live archive'); }
    });
    assert.equal(reopened.status, 'ready');
    assert.equal(reopened.archiveSource, source);
    assert.ok(reopened.events.some(event => event.activity === 'archive-resume-hit'));
    const resumed = Date.now();
    session = await createHlsSession({ root, produce: directory => startHlsConversion(reopened, {}, 110.900803, directory) });
    let deadline;
    try {
      await Promise.race([session.ready(), new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Resume paced through discarded footage instead of preparing segments promptly')), 8000);
      })]);
    } finally { clearTimeout(deadline); }
    assert.ok(Date.now() - resumed < 8000);
    assert.equal(source.complete, false, 'resuming within the extracted prefix must not wait for the archive tail');
    assert.ok(reopened.events.some(event => event.activity === 'encoding-start' && event.start === 110.900803));
    const playlist = (await session.read('index.m3u8')).toString();
    assert.ok(playlist.includes('#EXTINF:'));
    await session.close();
    assert.equal((await readdir(root)).some(name => name.startsWith('hls-')), false);
  } finally { unblock(); await session?.close(); await source?.close(); await rm(root, { recursive: true, force: true }); }
});


function rarHeader(type, flags, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(7 + data.length);
  header[2] = type; header.writeUInt16LE(flags, 3); header.writeUInt16LE(header.length, 5); data.copy(header, 7);
  header.writeUInt16LE(crc32(header.subarray(2)) & 65535, 0);
  return header;
}

// Minimal RAR4 stored volumes: independent header CRCs and the full-file data
// CRC exercise the real native reader without needing the proprietary encoder.
function storedRarVolumes(video) {
  const name = Buffer.from('video.mkv'), volumes = [];
  for (let offset = 0; offset < video.length; offset += 1024 * 1024) {
    const data = video.subarray(offset, offset + 1024 * 1024), last = offset + data.length === video.length;
    const file = Buffer.alloc(25 + name.length);
    file.writeUInt32LE(data.length, 0); file.writeUInt32LE(video.length, 4); file[8] = 3;
    file.writeUInt32LE(last ? crc32(video) : crc32(data), 9); file[17] = 20; file[18] = 0x30;
    file.writeUInt16LE(name.length, 19); file.writeUInt32LE(0o100644, 21); name.copy(file, 25);
    volumes.push(Buffer.concat([Buffer.from('526172211a0700', 'hex'), rarHeader(0x73, offset ? 0x11 : 0x111, Buffer.alloc(6)), rarHeader(0x74, 0x8000 | (offset ? 1 : 0) | (last ? 0 : 2), file), data, rarHeader(0x7b, last ? 0 : 1)]));
  }
  return volumes;
}

function storedInput(volumes, reads = []) {
  const offsets = [0];
  for (const volume of volumes) offsets.push(offsets.at(-1) + volume.length);
  const archive = Buffer.concat(volumes);
  return { size: archive.length, volumeOffsets: offsets, close: async () => {}, async read(start, end) {
    reads.push([start, end]);
    return archive.subarray(start, end + 1);
  } };
}

function rar5Vint(value) {
  const bytes = [];
  do { const digit = value % 128; value = Math.floor(value / 128); bytes.push(digit | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function rar5Header(type, flags, body = Buffer.alloc(0), dataSize = 0) {
  const fields = Buffer.concat([rar5Vint(type), rar5Vint(flags), ...(flags & 2 ? [rar5Vint(dataSize)] : []), body]);
  const header = Buffer.concat([rar5Vint(fields.length), fields]);
  const crc = Buffer.alloc(4); crc.writeUInt32LE(crc32(header));
  return Buffer.concat([crc, header]);
}
function storedRar5Volumes(video) {
  const name = Buffer.from('video.mkv'), volumes = [];
  for (let offset = 0; offset < video.length; offset += 1024 * 1024) {
    const data = video.subarray(offset, offset + 1024 * 1024), last = offset + data.length === video.length;
    const main = rar5Header(1, 0, Buffer.concat([rar5Vint(offset ? 3 : 1), ...(offset ? [rar5Vint(offset / (1024 * 1024))] : [])]));
    const dataCrc = Buffer.alloc(4); dataCrc.writeUInt32LE(crc32(last ? video : data));
    const fields = Buffer.concat([rar5Vint(4), rar5Vint(video.length), rar5Vint(0), dataCrc, rar5Vint(0), rar5Vint(1), rar5Vint(name.length), name]);
    volumes.push(Buffer.concat([Buffer.from('526172211a070100', 'hex'), main,
      rar5Header(2, 2 | (offset ? 8 : 0) | (last ? 0 : 16), fields, data.length), data, rar5Header(5, 0, rar5Vint(last ? 0 : 1))]));
  }
  return volumes;
}

test('stored RAR maps a deep video range without reading the preceding video', async () => {
  const video = randomBytes(4 * 1024 * 1024 + 123), reads = [];
  const source = await tryCreateStoredRarSource(storedInput(storedRarVolumes(video), reads));
  try {
    assert.ok(source?.randomAccess);
    assert.equal(source.metadata.size, video.length);
    const before = reads.length, start = 3 * 1024 * 1024 + 55;
    const lease = source.retain();
    try {
      const response = await fetch(lease.url, { headers: { Range: `bytes=${start}-${start + 999}` } });
      assert.equal(response.status, 206);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(start, start + 1000));
      assert.deepEqual(reads.slice(before).map(([a, b]) => b - a + 1), [1000]);
    } finally { lease.close(); }
  } finally { await source?.close(); }
});

test('stored RAR5 maps video bytes across volume boundaries', async () => {
  const video = randomBytes(2 * 1024 * 1024 + 321), source = await tryCreateStoredRarSource(storedInput(storedRar5Volumes(video)));
  try {
    assert.ok(source?.randomAccess);
    const lease = source.retain(), start = 1024 * 1024 - 120;
    try {
      const response = await fetch(lease.url, { headers: { Range: `bytes=${start}-${start + 999}` } });
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(start, start + 1000));
    } finally { lease.close(); }
  } finally { await source?.close(); }
});

test('deep stored-RAR HLS resume fetches the seek window instead of the film prefix', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stored-rar-resume-'));
  let source, session;
  try {
    const path = join(root, 'film.mkv');
    await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '180', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-c:a', 'aac', path]);
    const video = await readFile(path), reads = [];
    source = await tryCreateStoredRarSource(storedInput(storedRarVolumes(video), reads));
    assert.ok(source?.randomAccess);
    const inspected = reads.length;
    const job = { media: { type: 'movie', id: 99 }, progressiveArchive: true, archiveSource: source, file: { subject: 'film.mkv' }, release: 'SDR', strategy: 'remux', mode: 'direct' };
    session = await createHlsSession({ root, produce: directory => startHlsConversion(job, {}, 135.123, directory) });
    await session.ready();
    assert.match((await session.read('index.m3u8')).toString(), /#EXTINF:/);
    const middle = reads.slice(inspected).filter(([start, end]) => start > video.length * .2 && end < video.length * .5);
    assert.equal(middle.length, 0, 'the converter must not download the archived video prefix to seek');
  } finally { await session?.close(); await source?.close(); await rm(root, { recursive: true, force: true }); }
});

test('compressed or damaged RAR headers retain the sequential extraction path', async () => {
  const video = randomBytes(2 * 1024 * 1024), volumes = storedRarVolumes(video);
  const compressed = volumes.map(volume => Buffer.from(volume));
  const at = 7 + 13, headerSize = compressed[0].readUInt16LE(at + 5);
  compressed[0][at + 7 + 18] = 0x33;
  compressed[0].writeUInt16LE(crc32(compressed[0].subarray(at + 2, at + headerSize)) & 65535, at);
  assert.equal(await inspectStoredRar(storedInput(compressed)), null);
  const damaged = volumes.map(volume => Buffer.from(volume));
  damaged[1][20] ^= 1;
  assert.equal(await inspectStoredRar(storedInput(damaged)), null);
  assert.equal(await tryCreateStoredRarSource(storedInput([Buffer.from('377abcaf271c0000', 'hex')])), null);
});

test('stored RAR verifies after playback starts and rejects a failed archive check', async () => {
  const video = randomBytes(1024 * 1024 + 1);
  let calls = 0, finish;
  const source = await tryCreateStoredRarSource(storedInput(storedRarVolumes(video)), {
    verify: () => { calls++; return new Promise((_, reject) => { finish = reject; }); }
  });
  try {
    assert.equal(calls, 0, 'verification must not delay opening the video');
    const first = source.verify(), second = source.verify();
    assert.equal(first, second);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    finish(new Error('Archive CRC mismatch'));
    await first;
    assert.match(source.failure?.message || '', /CRC mismatch/);
  } finally { await source.close(); }
});

test('multivolume stored RAR extracts through virtual ranges with matching bytes and CRC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'progressive-rar-'));
  let source;
  try {
    const video = randomBytes(3 * 1024 * 1024 + 500), archive = Buffer.concat(storedRarVolumes(video));
    source = await createProgressiveArchiveSource({ size: archive.length, read: async (start, end) => archive.subarray(start, end + 1), close: async () => {} }, { root });
    const lease = source.retain();
    const response = await fetch(lease.url);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), video);
    await source.completion;
    lease.close();
  } finally { await source?.close(); await rm(root, { recursive: true, force: true }); }
});

test('an obvious full-size RAR video starts before trailing volumes are inspected', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'progressive-rar-startup-'));
  let source, unblock;
  const reads = [];
  const held = new Promise(resolve => { unblock = resolve; });
  try {
    const video = randomBytes(3 * 1024 * 1024 + 500), archive = Buffer.concat(storedRarVolumes(video));
    source = await Promise.race([
      createProgressiveArchiveSource({ size: archive.length, close: async () => {}, async read(start, end) {
        reads.push([start, end]);
        if (start >= 1024 * 1024 && start < 2 * 1024 * 1024) await held;
        return archive.subarray(start, end + 1);
      } }, { root }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`startup inspected trailing archive volumes before exposing the main video: ${JSON.stringify(reads)}`)), 2000))
    ]);
    assert.equal(source.metadata.name, 'video.mkv');
    assert.ok(source.available >= 65536);
    unblock();
    await source.completion;
  } finally { unblock(); await source?.close(); await rm(root, { recursive: true, force: true }); }
});

test('compressed 7z selects the full video instead of a smaller sample', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compressed-7z-'));
  let source;
  try {
    const video = Buffer.from('full video payload '.repeat(100000));
    await writeFile(join(root, 'sample.mkv'), 'sample'); await writeFile(join(root, 'video.mkv'), video);
    await execute('7z', ['a', '-t7z', '-mx=1', join(root, 'video.7z'), join(root, 'sample.mkv'), join(root, 'video.mkv')]);
    const archive = await readFile(join(root, 'video.7z'));
    source = await createProgressiveArchiveSource({ size: archive.length, read: async (start, end) => archive.subarray(start, end + 1), close: async () => {} }, { root });
    assert.equal(source.metadata.name, 'video.mkv');
    const lease = source.retain();
    assert.deepEqual(Buffer.from(await (await fetch(lease.url)).arrayBuffer()), video);
    await source.completion; lease.close();
  } finally { await source?.close(); await rm(root, { recursive: true, force: true }); }
});

test('a late archive checksum failure rejects completion after early bytes were available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'corrupt-progressive-'));
  let source, unblock;
  const held = new Promise(resolve => { unblock = resolve; });
  try {
    const video = randomBytes(10 * 1024 * 1024);
    await writeFile(join(root, 'video.mkv'), video);
    await execute('7z', ['a', '-t7z', '-mx=0', join(root, 'video.7z'), join(root, 'video.mkv')]);
    const archive = await readFile(join(root, 'video.7z'));
    const data = archive.indexOf(video.subarray(0, 32)); assert.ok(data >= 0);
    archive[data + video.length - 100] ^= 1;
    source = await createProgressiveArchiveSource({ size: archive.length, close: async () => {}, async read(start, end) {
      if (start >= 4 * 1024 * 1024 && end - start > 65536) await held;
      return archive.subarray(start, end + 1);
    } }, { root });
    assert.ok(source.available > 0); assert.equal(source.complete, false);
    unblock();
    await assert.rejects(source.completion, /CRC|checksum|damaged/i);
    assert.ok(source.failure);
  } finally { unblock(); await source?.close(); await rm(root, { recursive: true, force: true }); }
});

test('an abandoned progressive source closes its helper and removes temporary output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abandoned-progressive-'));
  let source;
  try {
    const video = randomBytes(10 * 1024 * 1024);
    await writeFile(join(root, 'video.mkv'), video);
    await execute('7z', ['a', '-t7z', '-mx=0', join(root, 'video.7z'), join(root, 'video.mkv')]);
    const archive = await readFile(join(root, 'video.7z'));
    source = await createProgressiveArchiveSource({ size: archive.length, close: async () => {}, async read(start, end, signal) {
      if (start >= 4 * 1024 * 1024 && end - start > 65536) await new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); if (signal.aborted) resolve(); });
      return archive.subarray(start, end + 1);
    } }, { root, idleMs: 50 });
    await assert.rejects(source.completion, /closed/);
    await source.close();
    assert.equal(source.closed, true);
    assert.equal((await readdir(root)).some(name => name.startsWith('playback-progressive-')), false);
  } finally { await source?.close(); await rm(root, { recursive: true, force: true }); }
});

test('a temporary extraction pause does not kill an established progressive HLS conversion', { timeout: 40000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-pause-'));
  let source, producer, unblock;
  const held = new Promise(resolve => { unblock = resolve; });
  try {
    const videoPath = join(root, 'video.mkv');
    await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', videoPath]);
    await execute('7z', ['a', '-t7z', '-mx=0', join(root, 'video.7z'), videoPath]);
    const archive = await readFile(join(root, 'video.7z'));
    source = await createProgressiveArchiveSource({ size: archive.length, close: async () => {}, async read(start, end) {
      if (start >= archive.length * 0.7 && end < archive.length - 65536) await held;
      return archive.subarray(start, end + 1);
    } }, { root });
    const job = { progressiveArchive: true, archiveSource: source, file: { subject: 'video.mkv' }, release: 'Fixture SDR H264', strategy: 'remux', mode: 'direct' };
    // Consume the available prefix promptly so this isolates the input wait,
    // independent of the normal conversion pacing and media length.
    producer = await startHlsConversion(job, {}, 0, root, () => {}, async () => []);
    let failure;
    void producer.completion.catch(error => { failure = error; });
    await new Promise(resolve => setTimeout(resolve, 18000));
    unblock();
    await source.completion;
    await producer.completion;
    assert.equal(failure, undefined);
    assert.match(await readFile(join(root, 'index.m3u8'), 'utf8'), /#EXT-X-ENDLIST/);
  } finally { unblock(); await producer?.stop(); await source?.close(); await rm(root, { recursive: true, force: true }); }
});

test('archive extraction keeps memory bounded across repeated native read buffers', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-memory-'));
  let source, lease;
  try {
    const videoPath = join(root, 'video.mkv');
    await writeFile(videoPath, Buffer.alloc(128 * 1024 * 1024, 42));
    await execute('7z', ['a', '-t7z', '-mx=0', join(root, 'video.7z'), videoPath]);
    const archive = await readFile(join(root, 'video.7z'));
    const helper = join(root, 'bounded-helper.py');
    // Lower the child ceiling so retained 4 MiB read buffers reproduce the
    // large-release failure quickly, without a multi-gigabyte test fixture.
    const script = new URL('../scripts/progressive-archive.py', import.meta.url).pathname;
    await writeFile(helper, `import resource, runpy\nresource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024, 128 * 1024 * 1024))\nrunpy.run_path(${JSON.stringify(script)}, run_name='__main__')\n`);
    source = await createProgressiveArchiveSource({ size: archive.length, close: async () => {}, read: async (start, end) => archive.subarray(start, end + 1) }, { root, helper });
    lease = source.retain();
    await source.completion;
    assert.equal(source.available, 128 * 1024 * 1024);
    assert.equal(source.complete, true);
  } finally { lease?.close(); await source?.close(); await rm(root, { recursive: true, force: true }); }
});
