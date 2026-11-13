import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { get } from 'node:http';
import { inspectArchiveHeader, inspectStoredRar, tryCreateStoredRarSource } from '../src/lib/server/stored-rar-source.js';

const RAR4 = Buffer.from('526172211a0700', 'hex');
const RAR5 = Buffer.from('526172211a070100', 'hex');
function rar4Header(type, flags, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(7 + data.length);
  header[2] = type; header.writeUInt16LE(flags, 3); header.writeUInt16LE(header.length, 5); data.copy(header, 7);
  header.writeUInt16LE(crc32(header.subarray(2)) & 65535);
  return header;
}
function vint(value) {
  const bytes = [];
  do { const digit = value % 128; value = Math.floor(value / 128); bytes.push(digit | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function rar5Header(type, flags, body = Buffer.alloc(0), dataSize = 0, extra = Buffer.alloc(0)) {
  const fields = Buffer.concat([vint(type), vint(flags), ...(flags & 1 ? [vint(extra.length)] : []),
    ...(flags & 2 ? [vint(dataSize)] : []), body, extra]);
  const header = Buffer.concat([vint(fields.length), fields]);
  const crc = Buffer.alloc(4); crc.writeUInt32LE(crc32(header));
  return Buffer.concat([crc, header]);
}
function volume(data, index, count, total, { method = 0x30, encrypted = false, name = 'video.mkv', padding = 0 } = {}) {
  const encodedName = Buffer.from(name), file = Buffer.alloc(25 + encodedName.length + padding);
  file.writeUInt32LE(data.length); file.writeUInt32LE(total, 4); file[8] = 3; file[17] = 20; file[18] = method;
  file.writeUInt16LE(encodedName.length, 19); encodedName.copy(file, 25);
  return Buffer.concat([RAR4, rar4Header(0x73, 0, Buffer.alloc(6)),
    rar4Header(0x74, 0x8000 | (index ? 1 : 0) | (index < count - 1 ? 2 : 0) | (encrypted ? 4 : 0), file), data]);
}
function fixture(count = 3, partSize = 100000, options = {}) {
  const video = Buffer.alloc(count * partSize);
  for (let at = 0; at < video.length; at++) video[at] = at % 251;
  const volumes = Array.from({ length: count }, (_, index) => volume(video.subarray(index * partSize, (index + 1) * partSize), index, count, video.length, options));
  return { video, volumes };
}
function inputFor(volumes, options = {}) {
  const archive = Buffer.concat(volumes), offsets = [0], headers = [], reads = [];
  for (const bytes of volumes) offsets.push(offsets.at(-1) + bytes.length);
  return { size: archive.length, volumeOffsets: offsets, headers, reads, ...options,
    async readVolumeHeader(index, count) { headers.push(index); return volumes[index].subarray(0, count); },
    async read(start, end, signal) { reads.push({ start, end, signal }); return archive.subarray(start, end + 1); }, async close() {} };
}
function rar5File({ method = 0, extra = Buffer.alloc(0) } = {}) {
  const name = Buffer.from('video.mkv');
  const body = Buffer.concat([vint(0), vint(1000), vint(0), vint(method << 7), vint(1), vint(name.length), name]);
  return Buffer.concat([RAR5, rar5Header(1, 0, vint(0)), rar5Header(2, 2 | (extra.length ? 1 : 0), body, 1000, extra)]);
}

test('header inspection distinguishes stored and compressed RAR without rejecting damaged or incomplete headers', () => {
  const { volumes } = fixture(1);
  assert.deepEqual(inspectArchiveHeader(volumes[0]), { kind: 'stored' });
  assert.deepEqual(inspectArchiveHeader(fixture(1, 100000, { method: 0x33 }).volumes[0]), { kind: 'extract' });
  assert.deepEqual(inspectArchiveHeader(rar5File()), { kind: 'stored' });
  assert.deepEqual(inspectArchiveHeader(rar5File({ method: 3 })), { kind: 'extract' });
  for (let length = 0; length < 61; length++) assert.deepEqual(inspectArchiveHeader(volumes[0].subarray(0, length)), { kind: 'unknown' });
  const damaged = Buffer.from(volumes[0]); damaged[25] ^= 4;
  assert.deepEqual(inspectArchiveHeader(damaged), { kind: 'unknown' });
  for (const bytes of [Buffer.from('504b0304', 'hex'), Buffer.from('377abcaf271c', 'hex'), Buffer.from('not an archive')]) {
    assert.deepEqual(inspectArchiveHeader(bytes), { kind: 'unknown' });
  }
});

test('only checksummed and structurally confirmed encryption is terminal', () => {
  const encrypted = fixture(1, 100000, { encrypted: true }).volumes[0];
  assert.throws(() => inspectArchiveHeader(encrypted), { code: 'ARCHIVE_ENCRYPTED' });
  const corrupt = Buffer.from(encrypted); corrupt[25] ^= 1;
  assert.deepEqual(inspectArchiveHeader(corrupt), { kind: 'unknown' });
  const mainEncrypted = Buffer.concat([RAR4, rar4Header(0x73, 0x80, Buffer.alloc(6))]);
  assert.throws(() => inspectArchiveHeader(mainEncrypted), { code: 'ARCHIVE_ENCRYPTED' });
  const encryptionBody = Buffer.concat([vint(0), vint(0), Buffer.from([15]), Buffer.alloc(16)]);
  assert.throws(() => inspectArchiveHeader(Buffer.concat([RAR5, rar5Header(4, 0, encryptionBody)])), { code: 'ARCHIVE_ENCRYPTED' });
  assert.deepEqual(inspectArchiveHeader(Buffer.concat([RAR5, rar5Header(4, 0, Buffer.from([0]))])), { kind: 'unknown' });
  const fileEncryption = Buffer.concat([vint(1), encryptionBody, Buffer.alloc(16)]);
  assert.throws(() => inspectArchiveHeader(rar5File({ extra: Buffer.concat([vint(fileEncryption.length), fileEncryption]) })), { code: 'ARCHIVE_ENCRYPTED' });
  assert.deepEqual(inspectArchiveHeader(rar5File({ extra: Buffer.from([1, 1]) })), { kind: 'unknown' });
});

test('only complete checksummed RAR headers with unsupported packing methods are rejected', () => {
  for (const bytes of [fixture(1, 100000, { method: 0x36 }).volumes[0], rar5File({ method: 6 })]) {
    assert.throws(() => inspectArchiveHeader(bytes), { code: 'ARCHIVE_UNSUPPORTED' });
    assert.deepEqual(inspectArchiveHeader(bytes.subarray(0, 40)), { kind: 'unknown' });
    const corrupted = Buffer.from(bytes);
    corrupted[25] ^= 1;
    assert.deepEqual(inspectArchiveHeader(corrupted), { kind: 'unknown' });
  }
});

test('rolling header readers honor the supplied budget and refill around a slow volume', async () => {
  const { volumes } = fixture(7), input = inputFor(volumes, { headerConcurrency: 2 });
  const original = input.readVolumeHeader.bind(input);
  let active = 0, maximum = 0, releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  input.readVolumeHeader = async (index, count) => {
    maximum = Math.max(maximum, ++active);
    try {
      if (index === 0) await slow;
      if (index === 6) releaseSlow();
      return await original(index, count);
    } finally { active--; }
  };
  try {
    const layout = await inspectStoredRar(input);
    assert.equal(maximum, 2);
    assert.equal(active, 0);
    assert.equal(layout.parts.length, 7);
    assert.deepEqual(layout.volumeOffsets, input.volumeOffsets);
    assert.notEqual(layout.volumeOffsets, input.volumeOffsets);
  } finally { releaseSlow(); }
});

test('failed inspection drains active readers before rejecting and stops scheduling more headers', async () => {
  const { volumes } = fixture(9), input = inputFor(volumes, { headerConcurrency: 3 });
  const original = input.readVolumeHeader.bind(input), failure = new Error('article unavailable'), started = [];
  let releaseSlow, settled = false, active = 0;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  input.readVolumeHeader = async (index, count) => {
    started.push(index); active++;
    try {
      if (index === 0) throw failure;
      await slow;
      return await original(index, count);
    } finally { active--; }
  };
  const opening = inspectStoredRar(input);
  opening.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(active, 2);
    assert.deepEqual(started, [0, 1, 2]);
    releaseSlow();
    await assert.rejects(opening, error => error === failure);
    assert.equal(active, 0);
  } finally { releaseSlow(); }
});

test('a malformed early header returns extraction fallback after draining without missing-result errors', async () => {
  const { volumes } = fixture(5), input = inputFor(volumes, { headerConcurrency: 1 });
  volumes[0][25] ^= 1;
  assert.equal(await inspectStoredRar(input), null);
  assert.deepEqual(input.headers, [0]);
});

test('a persisted layout validates endpoints without rereading middle volume headers', async () => {
  const { video, volumes } = fixture(5), input = inputFor(volumes);
  const layout = await inspectStoredRar(input);
  input.headers.length = 0;
  const source = await tryCreateStoredRarSource(input, { layout });
  try {
    assert.equal(source.layoutReused, true);
    assert.deepEqual(source.layout, layout);
    assert.notEqual(source.layout, layout);
    assert.deepEqual(input.headers.sort((a, b) => a - b), [0, 4]);
    const lease = source.retain();
    try {
      const response = await fetch(lease.url, { headers: { range: 'bytes=99975-100024' } });
      assert.equal(response.status, 206);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(99975, 100025));
    } finally { lease.close(); }
  } finally { await source?.close(); }
});

test('invalid persisted layout fields fall back to a newly inspected mapping', async () => {
  const { volumes } = fixture(3), layout = await inspectStoredRar(inputFor(volumes));
  const changes = [
    value => { value.volumeOffsets[1]++; },
    value => { value.parts[1].videoStart++; },
    value => { value.parts[1].archiveStart = -1; },
    value => { value.parts[1].length = 0; },
    value => { value.parts[1].videoEnd = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.size++; },
    value => { value.name = '../video.mkv'; },
    value => { value.name = 'other.mkv'; },
    value => { value.parts.pop(); }
  ];
  for (const change of changes) {
    const candidate = structuredClone(layout), input = inputFor(volumes);
    change(candidate);
    const source = await tryCreateStoredRarSource(input, { layout: candidate });
    try {
      assert.equal(source.layoutReused, false);
      assert.deepEqual(source.layout, layout);
      assert.ok(input.headers.includes(1), 'fallback must inspect the middle volume');
    } finally { await source?.close(); }
  }
});

test('changed volume offsets and changed endpoint headers cannot reuse a cached layout', async () => {
  const { video, volumes } = fixture(3), layout = await inspectStoredRar(inputFor(volumes));
  const shifted = [...volumes];
  shifted[0] = volume(video.subarray(0, 100000), 0, 3, video.length, { padding: 1 });
  const source = await tryCreateStoredRarSource(inputFor(shifted), { layout });
  try {
    assert.equal(source.layoutReused, false);
    assert.notDeepEqual(source.layout.volumeOffsets, layout.volumeOffsets);
  } finally { await source?.close(); }
  const renamed = [...volumes];
  renamed[2] = volume(video.subarray(200000), 2, 3, video.length, { name: 'other.mkv' });
  assert.equal(await tryCreateStoredRarSource(inputFor(renamed), { layout }), null);
  const compressed = [...volumes];
  compressed[2] = volume(video.subarray(200000), 2, 3, video.length, { method: 0x33 });
  assert.equal(await tryCreateStoredRarSource(inputFor(compressed), { layout }), null);
});

test('adaptive HTTP windows are clamped and return byte-exact ranges without crossing part boundaries', async () => {
  const { video, volumes } = fixture(1, 9 * 1024 * 1024);
  for (const [readAheadBytes, expected] of [[1, 65536], [98304, 98304], [32 * 1024 * 1024, 8 * 1024 * 1024], [undefined, 2 * 1024 * 1024]]) {
    const input = inputFor(volumes, { readAheadBytes }), source = await tryCreateStoredRarSource(input), lease = source.retain();
    try {
      const response = await fetch(lease.url, { headers: { range: `bytes=37-${video.length - 19}` } });
      assert.equal(response.headers.get('content-range'), `bytes 37-${video.length - 19}/${video.length}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(37, video.length - 18));
      assert.ok(input.reads.every(({ start, end }) => end - start + 1 <= expected));
    } finally { lease.close(); await source.close(); }
  }
  const split = fixture(3), input = inputFor(split.volumes, { readAheadBytes: 1 });
  const source = await tryCreateStoredRarSource(input), lease = source.retain();
  try {
    const response = await fetch(lease.url, { headers: { range: 'bytes=99975-200024' } });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), split.video.subarray(99975, 200025));
    assert.deepEqual(input.reads.map(({ start, end }) => end - start + 1), [25, 65536, 34464, 25]);
    input.reads.length = 0;
    assert.equal((await fetch(lease.url, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(lease.url, { headers: { range: 'bytes=300000-' } })).status, 416);
    assert.equal(input.reads.length, 0);
  } finally { lease.close(); await source.close(); }
});

test('disconnect aborts an in-flight read without poisoning later consumers', { timeout: 5000 }, async () => {
  const { video, volumes } = fixture(1, 300000), input = inputFor(volumes, { readAheadBytes: 65536 });
  const original = input.read.bind(input);
  let started, cancelled, pendingSignal;
  const reading = new Promise(resolve => { started = resolve; }), aborted = new Promise(resolve => { cancelled = resolve; });
  input.read = async (start, end, signal) => {
    if (!pendingSignal) {
      pendingSignal = signal; started();
      return new Promise((resolve, reject) => {
        const abort = () => { cancelled(); reject(signal.reason); };
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
    }
    return original(start, end, signal);
  };
  const source = await tryCreateStoredRarSource(input), lease = source.retain();
  const request = get(lease.url);
  request.on('error', () => {});
  try {
    await reading;
    request.destroy();
    await aborted;
    assert.equal(pendingSignal.aborted, true);
    assert.equal(input.reads.length, 0);
    assert.equal(source.failure, null);
    const response = await fetch(lease.url, { headers: { range: 'bytes=13-29' } });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(13, 30));
  } finally { request.destroy(); lease.close(); await source.close(); }
});

test('an unread HTTP response stops scheduling archive windows until the consumer drains', { timeout: 5000 }, async () => {
  const { volumes } = fixture(1, 16 * 1024 * 1024), input = inputFor(volumes, { readAheadBytes: 65536 });
  const source = await tryCreateStoredRarSource(input), lease = source.retain();
  let response;
  const request = get(lease.url, incoming => { response = incoming; incoming.pause(); });
  request.on('error', () => {});
  try {
    await new Promise((resolve, reject) => { request.once('response', resolve); request.once('error', reject); });
    let previous = -1, stable = 0;
    for (let count = 0; count < 40 && stable < 3; count++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      stable = input.reads.length === previous ? stable + 1 : 0;
      previous = input.reads.length;
    }
    assert.equal(stable, 3, 'bounded socket buffering must eventually stop upstream reads');
    assert.ok(input.reads.length < 256, 'the complete video must not queue behind an unread response');
  } finally { response?.destroy(); request.destroy(); lease.close(); await source.close(); }
});

test('header reader budgets are clamped to one through sixteen, including cached endpoint validation', async () => {
  const { volumes } = fixture(20, 1000);
  for (const [headerConcurrency, expected] of [[0, 1], [99, 16]]) {
    const input = inputFor(volumes, { headerConcurrency }), original = input.readVolumeHeader.bind(input);
    let active = 0, maximum = 0;
    input.readVolumeHeader = async (index, count) => {
      maximum = Math.max(maximum, ++active);
      try { await new Promise(resolve => setImmediate(resolve)); return await original(index, count); }
      finally { active--; }
    };
    const layout = await inspectStoredRar(input);
    assert.equal(maximum, expected);
    maximum = 0;
    const source = await tryCreateStoredRarSource(input, { layout });
    try {
      assert.equal(source.layoutReused, true);
      assert.equal(maximum, Math.min(expected, 2));
    } finally { await source?.close(); }
  }
});

test('sparse offsets and malformed encryption records remain inconclusive rather than trusted', async () => {
  const { volumes } = fixture(3), input = inputFor(volumes);
  delete input.volumeOffsets[1];
  assert.equal(await inspectStoredRar(input), null);
  assert.deepEqual(input.headers, []);
  const valid = inputFor(volumes), layout = await inspectStoredRar(valid);
  delete layout.volumeOffsets[1];
  valid.headers.length = 0;
  const source = await tryCreateStoredRarSource(valid, { layout });
  try {
    assert.equal(source.layoutReused, false);
    assert.ok(valid.headers.includes(1));
  } finally { await source?.close(); }
  const encryption = Buffer.concat([vint(1), vint(0), vint(0), Buffer.from([15]), Buffer.alloc(32)]);
  const extra = Buffer.concat([vint(encryption.length), encryption, Buffer.from([127])]);
  assert.deepEqual(inspectArchiveHeader(rar5File({ extra })), { kind: 'unknown' });
});

test('a changed endpoint declared size rejects reuse even when the byte layout still inspects successfully', async () => {
  const { video, volumes } = fixture(3), layout = await inspectStoredRar(inputFor(volumes));
  volumes[2] = volume(video.subarray(200000), 2, 3, video.length - 1);
  const input = inputFor(volumes), source = await tryCreateStoredRarSource(input, { layout });
  try {
    assert.equal(source.layoutReused, false);
    assert.ok(input.headers.includes(1));
    assert.deepEqual(source.layout, layout);
  } finally { await source?.close(); }
});

test('metadata can read validated endpoint bytes while middle headers remain pending, but completion still validates every volume', { timeout: 5000 }, async () => {
  const { video, volumes } = fixture(5), input = inputFor(volumes, { headerConcurrency: 2 });
  const readHeader = input.readVolumeHeader.bind(input);
  let releaseHeaders, timer, source, lease;
  const middle = new Promise(resolve => { releaseHeaders = resolve; });
  input.readVolumeHeader = async (index, bytes) => {
    if (index > 0 && index < volumes.length - 1) await middle;
    return readHeader(index, bytes);
  };
  const opening = tryCreateStoredRarSource(input, { overlapInspection: true });
  try {
    source = await Promise.race([opening, new Promise(resolve => { timer = setTimeout(() => resolve(null), 1000); })]);
    assert.ok(source, 'metadata must not wait for unrelated middle-volume headers');
    clearTimeout(timer);
    assert.equal(source.complete, false);
    assert.equal(source.layout, null, 'an unfinished mapping cannot be persisted');
    lease = source.retain();
    const prefix = await fetch(lease.url, { headers: { range: 'bytes=0-127' } });
    assert.deepEqual(Buffer.from(await prefix.arrayBuffer()), video.subarray(0, 128));
    const tail = await fetch(lease.url, { headers: { range: 'bytes=-127' } });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), video.subarray(-127));
    assert.equal(source.complete, false);
    releaseHeaders();
    await source.completion;
    assert.equal(source.complete, true);
    assert.equal(source.layout.parts.length, 5);
    assert.deepEqual([...new Set(input.headers)].sort(), [0, 1, 2, 3, 4]);
    const across = await fetch(lease.url, { headers: { range: 'bytes=99975-200024' } });
    assert.deepEqual(Buffer.from(await across.arrayBuffer()), video.subarray(99975, 200025));
  } finally {
    clearTimeout(timer); releaseHeaders();
    lease?.close(); await (source || await opening)?.close();
  }
});

test('overlapping inspection rejects inconsistent middle headers and preserves missing-article errors', async () => {
  for (const unavailable of [false, true]) {
    const { volumes } = fixture(5), input = inputFor(volumes);
    const readHeader = input.readVolumeHeader.bind(input);
    const missing = Object.assign(new Error('Middle article missing'), { code: 'USENET_ARTICLE_MISSING' });
    let releaseHeaders;
    const middle = new Promise(resolve => { releaseHeaders = resolve; });
    input.readVolumeHeader = async (index, count) => {
      if (index === 2) {
        await middle;
        if (unavailable) throw missing;
        return Buffer.alloc(64);
      }
      return readHeader(index, count);
    };
    const source = await tryCreateStoredRarSource(input, { overlapInspection: true });
    try {
      releaseHeaders();
      await assert.rejects(source.completion, error => unavailable ? error === missing : error.code === 'ARCHIVE_MAPPING_UNAVAILABLE');
      assert.equal(source.complete, false);
      assert.equal(source.layout, null);
      assert.ok(source.failure);
    } finally { releaseHeaders(); await source.close(); }
  }
});

test('closing an overlapping source drains the outstanding header inspection', async () => {
  const { volumes } = fixture(5), input = inputFor(volumes);
  const readHeader = input.readVolumeHeader.bind(input);
  let releaseHeaders, reading = 0, finished = 0;
  const middle = new Promise(resolve => { releaseHeaders = resolve; });
  input.readVolumeHeader = async (index, count) => {
    reading++;
    try { if (index === 2) await middle; return await readHeader(index, count); }
    finally { reading--; finished++; }
  };
  input.close = async () => { releaseHeaders(); };
  const source = await tryCreateStoredRarSource(input, { overlapInspection: true });
  try {
    await source.close();
    assert.equal(reading, 0);
    const drained = finished;
    await source.completion;
    assert.equal(finished, drained, 'no header reader survives close');
  } finally { releaseHeaders(); await source.close(); }
});

test('unknown declared size falls back to full inspection rather than guessing endpoint offsets', async () => {
  const { video } = fixture(5), partSize = video.length / 5;
  const volumes = Array.from({ length: 5 }, (_, index) => volume(video.subarray(index * partSize, (index + 1) * partSize), index, 5, 0));
  const source = await tryCreateStoredRarSource(inputFor(volumes), { overlapInspection: true });
  try {
    assert.equal(source.complete, true);
    assert.equal(source.layout.parts.length, 5);
    const lease = source.retain();
    try {
      const response = await fetch(lease.url, { headers: { range: 'bytes=99975-100024' } });
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(99975, 100025));
    } finally { lease.close(); }
  } finally { await source.close(); }
});

test('metadata receives the cached opening prefix before a bulk provider window is available', { timeout: 5000 }, async () => {
  const { video, volumes } = fixture(1, 1000000), input = inputFor(volumes, { readAheadBytes: 8 * 1024 * 1024 });
  const read = input.read.bind(input);
  let release, timer, source, lease;
  const held = new Promise(resolve => { release = resolve; });
  input.read = async (start, end, signal) => { if (end - start + 1 > 65536) await held; return read(start, end, signal); };
  const controller = new AbortController();
  const opening = (async () => {
    const response = await fetch(lease.url, { signal: controller.signal });
    const reader = response.body.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    return Buffer.from(chunk.value);
  });
  let pending;
  try {
    source = await tryCreateStoredRarSource(input); lease = source.retain();
    pending = opening();
    void pending.catch(() => {});
    const bytes = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), 250); })]);
    assert.ok(bytes, 'small metadata reads must not wait for an entire bulk window');
    assert.ok(bytes.length > 0 && bytes.length <= 65536);
    assert.deepEqual(bytes, video.subarray(0, bytes.length));
  } finally {
    clearTimeout(timer); controller.abort(); release();
    await pending?.catch(() => {}); lease?.close(); await source?.close();
  }
});
