import { createServer } from 'node:http';
import { crc32 } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { waitForDrain } from './stream-drain.js';
import { archiveByteRange } from './progressive-archive.js';

const RAR4 = Buffer.from('526172211a0700', 'hex');
const RAR5 = Buffer.from('526172211a070100', 'hex');
const VIDEO = /\.(mkv|mp4|m4v|mov|webm)$/i;
const SAMPLE = /(^|[._ -])(sample|trailer|preview|proof)([._ -]|$)/i;

function vint(bytes, at, end = bytes.length) {
  let value = 0, scale = 1;
  for (let i = 0; i < 10 && at < end; i++, scale *= 128) {
    const byte = bytes[at++];
    value += (byte & 127) * scale;
    if (!Number.isSafeInteger(value)) return null;
    if (!(byte & 128)) return { value, at };
  }
  return null;
}

function encrypted() {
  return Object.assign(new Error('Archive headers or file data are encrypted'), { code: 'ARCHIVE_ENCRYPTED' });
}

function unsupported() {
  return Object.assign(new Error('Archive uses an unsupported RAR packing method'), { code: 'ARCHIVE_UNSUPPORTED' });
}

function rar5Encryption(bytes, at, end, file = false) {
  const version = vint(bytes, at, end);
  if (!version || version.value !== 0) return false;
  const flags = vint(bytes, version.at, end);
  if (!flags || flags.value & ~3 || flags.at >= end || bytes[flags.at] > 24) return false;
  return flags.at + 1 + 16 + (file ? 16 : 0) + (flags.value & 1 ? 12 : 0) === end;
}

function rar4Part(bytes) {
  if (!bytes.subarray(0, 7).equals(RAR4)) return null;
  let at = 7, main = false;
  for (let i = 0; i < 8 && at + 7 <= bytes.length; i++) {
    const size = bytes.readUInt16LE(at + 5), type = bytes[at + 2], flags = bytes.readUInt16LE(at + 3);
    if (size < 7 || at + size > bytes.length || (crc32(bytes.subarray(at + 2, at + size)) & 0xffff) !== bytes.readUInt16LE(at)) return null;
    if (type === 0x73) {
      if (main || size < 13) return null;
      if (flags & 0x80) throw encrypted();
      main = true; at += size; continue;
    }
    if (!main || type !== 0x74 || size < 32 || !(flags & 0x8000)) return null;
    const data = at + 7, high = Boolean(flags & 0x100), nameAt = data + (high ? 33 : 25);
    if (nameAt > at + size) return null;
    const packed = bytes.readUInt32LE(data) + (high ? bytes.readUInt32LE(data + 25) * 2 ** 32 : 0);
    const unpacked = bytes.readUInt32LE(data + 4) + (high ? bytes.readUInt32LE(data + 29) * 2 ** 32 : 0);
    const nameLength = bytes.readUInt16LE(data + 19);
    const method = bytes[data + 18];
    if (nameAt + nameLength > at + size || !Number.isSafeInteger(packed) || !Number.isSafeInteger(unpacked)) return null;
    if (flags & 0x04) throw encrypted();
    if (method < 0x30 || method > 0x35) throw unsupported();
    return { name: bytes.subarray(nameAt, nameAt + nameLength), packed, unpacked, start: at + size,
      stored: method === 0x30, before: Boolean(flags & 1), after: Boolean(flags & 2) };
  }
  return null;
}

function rar5Part(bytes) {
  if (!bytes.subarray(0, 8).equals(RAR5)) return null;
  let at = 8, main = false;
  for (let i = 0; i < 8 && at + 7 <= bytes.length; i++) {
    const sizeField = vint(bytes, at + 4);
    if (!sizeField || sizeField.at - at > 7 || sizeField.value > 2 * 1024 * 1024) return null;
    const end = sizeField.at + sizeField.value;
    if (end > bytes.length || crc32(bytes.subarray(at + 4, end)) !== bytes.readUInt32LE(at)) return null;
    at = sizeField.at;
    const type = vint(bytes, at, end); if (!type) return null; at = type.at;
    const flags = vint(bytes, at, end); if (!flags) return null; at = flags.at;
    const extra = flags.value & 1 ? vint(bytes, at, end) : { value: 0, at };
    if (!extra) return null; at = extra.at;
    const data = flags.value & 2 ? vint(bytes, at, end) : { value: 0, at };
    if (!data) return null; at = data.at;
    if (extra.value > end - at) return null;
    if (type.value === 4) {
      if (flags.value || !rar5Encryption(bytes, at, end)) return null;
      throw encrypted();
    }
    if (type.value === 1) {
      const archiveFlags = vint(bytes, at, end - extra.value);
      if (main || !archiveFlags) return null;
      main = true; at = end + data.value; continue;
    }
    if (!main || type.value !== 2 || !(flags.value & 2) || flags.value & 0x20) return null;
    const fileFlags = vint(bytes, at, end); if (!fileFlags || fileFlags.value & 1) return null; at = fileFlags.at;
    const unpacked = vint(bytes, at, end); if (!unpacked) return null; at = unpacked.at;
    const attributes = vint(bytes, at, end); if (!attributes) return null; at = attributes.at;
    if (fileFlags.value & 2) at += 4;
    if (fileFlags.value & 4) at += 4;
    const compression = vint(bytes, at, end); if (!compression) return null; at = compression.at;
    const host = vint(bytes, at, end); if (!host) return null; at = host.at;
    const nameLength = vint(bytes, at, end); if (!nameLength) return null; at = nameLength.at;
    if (nameLength.value > 4096 || at + nameLength.value > end - extra.value) return null;
    const name = bytes.subarray(at, at + nameLength.value);
    let fileEncrypted = false;
    if (extra.value) {
      let recordAt = end - extra.value;
      while (recordAt < end) {
        const recordSize = vint(bytes, recordAt, end);
        if (!recordSize || recordSize.value < 1 || recordSize.at + recordSize.value > end) return null;
        const recordType = vint(bytes, recordSize.at, recordSize.at + recordSize.value);
        if (!recordType) return null;
        if (recordType.value === 1) {
          if (!rar5Encryption(bytes, recordType.at, recordSize.at + recordSize.value, true)) return null;
          fileEncrypted = true;
        }
        recordAt = recordSize.at + recordSize.value;
      }
    }
    if (fileEncrypted) throw encrypted();
    if ((compression.value >>> 7 & 7) > 5) throw unsupported();
    return { name, packed: data.value, unpacked: fileFlags.value & 8 ? 0 : unpacked.value,
      start: end, stored: !(compression.value & 0x380), before: Boolean(flags.value & 8), after: Boolean(flags.value & 16) };
  }
  return null;
}

// An inconclusive prefix always leaves sequential extraction available. In
// particular, ordinary compression is supported, not a terminal format error.
export function inspectArchiveHeader(bytes) {
  if (!(bytes instanceof Uint8Array)) return { kind: 'unknown' };
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const part = rar5Part(bytes) || rar4Part(bytes);
  return { kind: part ? part.stored ? 'stored' : 'extract' : 'unknown' };
}

function validOffsets(input) {
  const offsets = input.volumeOffsets;
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || !Array.isArray(offsets) || offsets.length < 2
    || offsets[0] !== 0 || offsets.at(-1) !== input.size) return false;
  for (let index = 1; index < offsets.length; index++) {
    if (!Number.isSafeInteger(offsets[index]) || offsets[index] <= offsets[index - 1]) return false;
  }
  return true;
}

async function readStoredPart(input, offsets, index, headerBytes) {
  const header = await input.readVolumeHeader(index, headerBytes);
  const kind = header.subarray(0, 8).equals(RAR5) ? 5 : header.subarray(0, 7).equals(RAR4) ? 4 : 0;
  let part = kind === 5 ? rar5Part(header) : kind === 4 ? rar4Part(header) : null;
  if (part && (!part.stored || !part.packed || part.start + part.packed > offsets[index + 1] - offsets[index]
    || part.before !== (index > 0) || part.after !== (index < offsets.length - 2))) part = null;
  if (part && index === 0) {
    const title = part.name.toString('utf8').split(/[\\/]/).at(-1);
    if (!VIDEO.test(title) || SAMPLE.test(title)) part = null;
  }
  if (part) part.name = Buffer.from(part.name);
  return { kind, part };
}

function headerReaders(input) {
  return Number.isFinite(input.headerConcurrency) ? Math.max(1, Math.min(16, Math.floor(input.headerConcurrency))) : 8;
}

export async function inspectStoredRar(input, { headerBytes = 65536 } = {}) {
  if (!validOffsets(input)) return null;
  const offsets = [...input.volumeOffsets];
  const parts = [], headers = [];
  const count = offsets.length - 1;
  let next = 0, stopped = false;
  const concurrency = headerReaders(input);
  // Refill each reader independently; a slow header must not leave others idle.
  // Drain all active readers before fallback can reuse or close the input.
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (!stopped && next < count) {
      const index = next++;
      try {
        const result = await readStoredPart(input, offsets, index, headerBytes);
        headers[index] = result;
        if (!result.part) stopped = true;
      } catch (error) { headers[index] = { error }; stopped = true; }
    }
  }));
  const failed = headers.find(result => result?.error);
  if (failed) throw failed.error;
  let format, name, declaredSize = 0;
  for (let index = 0; index < count; index++) {
    const begin = offsets[index], result = headers[index];
    if (!result) return null;
    const { kind, part } = result;
    if (!part || format && kind !== format) return null;
    format = kind;
    if (index === 0) {
      name = part.name;
      declaredSize = part.unpacked;
    } else if (!part.name.equals(name)) return null;
    parts.push({ videoStart: parts.length ? parts.at(-1).videoEnd : 0, archiveStart: begin + part.start, length: part.packed,
      videoEnd: (parts.length ? parts.at(-1).videoEnd : 0) + part.packed });
  }
  const size = parts.at(-1)?.videoEnd;
  if (!Number.isSafeInteger(size) || size <= 0 || size < input.size / 2 || (declaredSize && declaredSize !== size)) return null;
  return { name: name.toString('utf8').split(/[\\/]/).at(-1), size, parts, volumeOffsets: offsets };
}

function copyLayout(input, layout) {
  if (!validOffsets(input) || !layout || typeof layout !== 'object'
    || typeof layout.name !== 'string' || !layout.name || Buffer.byteLength(layout.name) > 4096
    || /[\\/\0]/.test(layout.name) || !VIDEO.test(layout.name) || SAMPLE.test(layout.name)
    || !Number.isSafeInteger(layout.size) || layout.size <= 0 || layout.size < input.size / 2 || layout.size > input.size
    || !Array.isArray(layout.volumeOffsets) || layout.volumeOffsets.length !== input.volumeOffsets.length
    || !input.volumeOffsets.every((offset, index) => offset === layout.volumeOffsets[index])
    || !Array.isArray(layout.parts) || layout.parts.length !== input.volumeOffsets.length - 1) return null;
  const parts = [];
  let end = 0;
  for (let index = 0; index < layout.parts.length; index++) {
    const part = layout.parts[index];
    if (!part || !['videoStart', 'archiveStart', 'length', 'videoEnd'].every(key => Number.isSafeInteger(part[key]))
      || part.videoStart !== end || part.length <= 0 || part.videoEnd !== part.videoStart + part.length
      || part.archiveStart <= input.volumeOffsets[index]
      || part.archiveStart + part.length > input.volumeOffsets[index + 1]) return null;
    parts.push({ videoStart: part.videoStart, archiveStart: part.archiveStart, length: part.length, videoEnd: part.videoEnd });
    end = part.videoEnd;
  }
  if (end !== layout.size) return null;
  return { name: layout.name, size: layout.size, parts, volumeOffsets: [...layout.volumeOffsets] };
}

async function reuseLayout(input, layout) {
  const mapping = copyLayout(input, layout);
  if (!mapping) return null;
  const last = mapping.parts.length - 1, indices = last ? [0, last] : [0], results = [];
  // Respect even a one-reader provider budget, and drain both endpoints before
  // falling back. Header failures retain their original source error.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(headerReaders(input), indices.length) }, async () => {
    while (next < indices.length) {
      const index = indices[next++];
      try { results[index] = await readStoredPart(input, mapping.volumeOffsets, index, 65536); }
      catch (error) { results[index] = { error }; }
    }
  }));
  const failed = indices.map(index => results[index]).find(result => result.error);
  if (failed) throw failed.error;
  const first = results[0];
  for (const index of indices) {
    const result = results[index], part = result.part, expected = mapping.parts[index];
    if (!part || result.kind !== first.kind || !part.name.equals(first.part.name)
      || part.name.toString('utf8').split(/[\\/]/).at(-1) !== mapping.name
      || mapping.volumeOffsets[index] + part.start !== expected.archiveStart || part.packed !== expected.length
      || part.unpacked && part.unpacked !== mapping.size) return null;
  }
  return mapping;
}

// Endpoints locate only the prefix and suffix, never guessed middle offsets.
// This lets metadata reads overlap full inspection without trusting unseen headers.
async function openingLayout(input) {
  if (!validOffsets(input) || input.volumeOffsets.length < 4) return null;
  const offsets = input.volumeOffsets, lastIndex = offsets.length - 2;
  const first = await readStoredPart(input, offsets, 0, 65536);
  if (!first.part || !Number.isSafeInteger(first.part.unpacked) || first.part.unpacked <= 0) return null;
  const last = await readStoredPart(input, offsets, lastIndex, 65536);
  const size = first.part.unpacked;
  if (!last.part || first.kind !== last.kind || !last.part.name.equals(first.part.name)
    || size < input.size / 2 || size > input.size || size <= first.part.packed + last.part.packed
    || last.part.unpacked && last.part.unpacked !== size) return null;
  return {
    name: first.part.name.toString('utf8').split(/[\\/]/).at(-1), size, volumeOffsets: [...offsets],
    parts: [
      { videoStart: 0, archiveStart: first.part.start, length: first.part.packed, videoEnd: first.part.packed },
      { videoStart: size - last.part.packed, archiveStart: offsets[lastIndex] + last.part.start, length: last.part.packed, videoEnd: size }
    ]
  };
}

// A stored RAR part is already the original media bytes. Serve only the ranges
// FFmpeg requests; the NNTP loader still validates each fetched article.
// overlapInspection permits provisional endpoint reads. Callers must await
// completion before exposing playback; layout stays null until every header passes.
export async function tryCreateStoredRarSource(input, { idleMs = 30000, verify = null, layout = null, overlapInspection = false } = {}) {
  const reused = layout ? await reuseLayout(input, layout) : null;
  const opening = !reused && overlapInspection ? await openingLayout(input) : null;
  let mapping = reused || opening || await inspectStoredRar(input);
  if (!mapping) return null;
  const token = randomUUID();
  const readWindow = Number.isFinite(input.readAheadBytes)
    ? Math.max(65536, Math.min(8 * 1024 * 1024, Math.floor(input.readAheadBytes))) : 2 * 1024 * 1024;
  const requests = new Set();
  let closed = false, closing, idle, refs = 0, failure = null, verification, complete = !opening;
  const verificationController = new AbortController();
  const server = createServer((req, res) => {
    const controller = new AbortController();
    requests.add(controller);
    res.on('close', () => { requests.delete(controller); controller.abort(); });
    void (async () => {
      if (req.url !== `/${token}/video` || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); return res.end(); }
      if (closed || failure) throw failure || new Error('Archive source closed');
      const range = archiveByteRange(req.headers.range, mapping.size);
      if (!range) { res.writeHead(416, { 'content-range': `bytes */${mapping.size}` }); return res.end(); }
      const { start, end, partial } = range;
      res.writeHead(partial ? 206 : 200, { 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream', ...(partial ? { 'content-range': `bytes ${start}-${end}/${mapping.size}` } : {}) });
      if (req.method === 'HEAD') return res.end();
      let cursor = start;
      while (cursor <= end && !controller.signal.aborted) {
        const part = mapping.parts.find(part => part.videoStart <= cursor && cursor < part.videoEnd);
        if (!part) { await completion; continue; }
        const first = cursor, last = Math.min(end, part.videoEnd - 1);
        for (let at = first; at <= last && !controller.signal.aborted;) {
          // Container headers often seek again after only a few KiB. Publish
          // their cached prefix before waiting for a full bulk payload window.
          const stop = Math.min(last, at + (at === start ? Math.min(readWindow, 65536) : readWindow) - 1);
          const bytes = await input.read(part.archiveStart + at - part.videoStart, part.archiveStart + stop - part.videoStart, controller.signal);
          if (controller.signal.aborted) return;
          if (bytes.length !== stop - at + 1) throw new Error('Incomplete stored RAR video range');
          if (!res.write(bytes)) await waitForDrain(res);
          at = stop + 1;
        }
        cursor = last + 1;
      }
      if (!controller.signal.aborted) res.end();
    })().catch(error => {
      if (controller.signal.aborted) return;
      failure ||= error;
      if (res.headersSent) res.destroy(); else { res.writeHead(500); res.end(); }
    });
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
  catch (error) { await input.close(); throw error; }
  const completion = opening ? inspectStoredRar(input).then(validated => {
    if (!validated || validated.name !== opening.name || validated.size !== opening.size
      || !opening.parts.every((part, index) => {
        const endpoint = index ? validated.parts.at(-1) : validated.parts[0];
        return endpoint && endpoint.archiveStart === part.archiveStart && endpoint.length === part.length
          && endpoint.videoStart === part.videoStart && endpoint.videoEnd === part.videoEnd;
      })) throw Object.assign(new Error('Stored archive headers do not form a consistent video mapping.'), { code: 'ARCHIVE_MAPPING_UNAVAILABLE' });
    if (failure) throw failure;
    mapping = validated; complete = true;
  }).catch(error => {
    failure ||= error;
    server.closeAllConnections();
    throw error;
  }) : Promise.resolve();
  void completion.catch(() => {});
  function expire(ttl = idleMs) { clearTimeout(idle); idle = setTimeout(() => void close().catch(() => {}), ttl); idle.unref(); }
  function close() {
    if (closing) return closing;
    closed = true; clearTimeout(idle); verificationController.abort();
    for (const controller of requests) controller.abort();
    server.closeAllConnections();
    closing = Promise.all([input.close(), new Promise(resolve => server.close(resolve)), completion.catch(() => {}), verification?.catch(() => {})]).then(() => {});
    return closing;
  }
  expire();
  const url = `http://127.0.0.1:${server.address().port}/${token}/video`;
  return { metadata: { name: mapping.name, size: mapping.size }, completion, layoutReused: Boolean(reused),
    get layout() { return complete ? mapping : null; },
    get consumers() { return refs; }, get closed() { return closed; }, get failure() { return failure; },
    get available() { return mapping.size; }, get complete() { return complete; }, randomAccess: true,
    verify() {
      if (!verify || closed) return;
      if (!verification) verification = Promise.resolve().then(() => verify(verificationController.signal)).catch(error => {
        if (!verificationController.signal.aborted) { failure ||= error; server.closeAllConnections(); }
      });
      return verification;
    },
    retain() { if (closed || failure) throw failure || new Error('Archive source closed'); refs++; clearTimeout(idle);
      let released = false; return { url, close() { if (!released) { released = true; if (--refs === 0) expire(Math.min(idleMs, 5000)); } } };
    }, close };
}
