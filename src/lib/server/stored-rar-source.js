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

function rar4Part(bytes) {
  if (!bytes.subarray(0, 7).equals(RAR4)) return null;
  let at = 7, main = false;
  for (let i = 0; i < 8 && at + 7 <= bytes.length; i++) {
    const size = bytes.readUInt16LE(at + 5), type = bytes[at + 2], flags = bytes.readUInt16LE(at + 3);
    if (size < 7 || at + size > bytes.length || (crc32(bytes.subarray(at + 2, at + size)) & 0xffff) !== bytes.readUInt16LE(at)) return null;
    if (type === 0x73) {
      if (main || flags & 0x80) return null;
      main = true; at += size; continue;
    }
    if (!main || type !== 0x74 || size < 32 || !(flags & 0x8000) || flags & 0x04) return null;
    const data = at + 7, high = Boolean(flags & 0x100), nameAt = data + (high ? 33 : 25);
    if (nameAt > at + size) return null;
    const packed = bytes.readUInt32LE(data) + (high ? bytes.readUInt32LE(data + 25) * 2 ** 32 : 0);
    const unpacked = bytes.readUInt32LE(data + 4) + (high ? bytes.readUInt32LE(data + 29) * 2 ** 32 : 0);
    const nameLength = bytes.readUInt16LE(data + 19);
    if (nameAt + nameLength > at + size || !Number.isSafeInteger(packed) || !Number.isSafeInteger(unpacked) || bytes[data + 18] !== 0x30) return null;
    return { name: bytes.subarray(nameAt, nameAt + nameLength), packed, unpacked, start: at + size, before: Boolean(flags & 1), after: Boolean(flags & 2) };
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
    if (type.value === 1) {
      if (main) return null;
      main = true; at = end + data.value; continue;
    }
    if (!main || type.value !== 2 || !(flags.value & 2) || flags.value & 0x20) return null;
    const fileFlags = vint(bytes, at, end); if (!fileFlags || fileFlags.value & 1) return null; at = fileFlags.at;
    const unpacked = vint(bytes, at, end); if (!unpacked) return null; at = unpacked.at;
    const attributes = vint(bytes, at, end); if (!attributes) return null; at = attributes.at;
    if (fileFlags.value & 2) at += 4;
    if (fileFlags.value & 4) at += 4;
    const compression = vint(bytes, at, end); if (!compression || compression.value & 0x380) return null; at = compression.at;
    const host = vint(bytes, at, end); if (!host) return null; at = host.at;
    const nameLength = vint(bytes, at, end); if (!nameLength) return null; at = nameLength.at;
    if (nameLength.value > 4096 || at + nameLength.value > end - extra.value) return null;
    const name = bytes.subarray(at, at + nameLength.value);
    if (extra.value) {
      let recordAt = end - extra.value;
      while (recordAt < end) {
        const recordSize = vint(bytes, recordAt, end);
        if (!recordSize || recordSize.value < 1 || recordSize.at + recordSize.value > end) return null;
        const recordType = vint(bytes, recordSize.at, recordSize.at + recordSize.value);
        if (!recordType || recordType.value === 1) return null; // Encrypted file data.
        recordAt = recordSize.at + recordSize.value;
      }
    }
    return { name, packed: data.value, unpacked: fileFlags.value & 8 ? 0 : unpacked.value,
      start: end, before: Boolean(flags.value & 8), after: Boolean(flags.value & 16) };
  }
  return null;
}

export async function inspectStoredRar(input, { headerBytes = 65536 } = {}) {
  const offsets = input.volumeOffsets;
  if (!Array.isArray(offsets) || offsets.length < 2 || offsets[0] !== 0 || offsets.at(-1) !== input.size) return null;
  const parts = [];
  let format, name, declaredSize = 0;
  for (let index = 0; index < offsets.length - 1; index++) {
    const begin = offsets[index], end = offsets[index + 1];
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || end <= begin) return null;
    const header = await input.read(begin, Math.min(end, begin + headerBytes) - 1);
    const kind = header.subarray(0, 8).equals(RAR5) ? 5 : header.subarray(0, 7).equals(RAR4) ? 4 : 0;
    if (!kind || format && kind !== format) return null;
    format = kind;
    const part = kind === 5 ? rar5Part(header) : rar4Part(header);
    if (!part || !part.packed || part.start + part.packed > end - begin || part.before !== (index > 0) || part.after !== (index < offsets.length - 2)) return null;
    if (index === 0) {
      name = part.name;
      declaredSize = part.unpacked;
      const title = name.toString('utf8').split(/[\\/]/).at(-1);
      if (!VIDEO.test(title) || SAMPLE.test(title)) return null;
    } else if (!part.name.equals(name)) return null;
    parts.push({ videoStart: parts.length ? parts.at(-1).videoEnd : 0, archiveStart: begin + part.start, length: part.packed,
      videoEnd: (parts.length ? parts.at(-1).videoEnd : 0) + part.packed });
  }
  const size = parts.at(-1)?.videoEnd;
  if (!Number.isSafeInteger(size) || size <= 0 || size < input.size / 2 || (declaredSize && declaredSize !== size)) return null;
  return { name: name.toString('utf8').split(/[\\/]/).at(-1), size, parts };
}

// A stored RAR part is already the original media bytes. Serve only the ranges
// FFmpeg requests; the NNTP loader still validates each fetched article.
export async function tryCreateStoredRarSource(input, { idleMs = 30000, verify = null } = {}) {
  const mapping = await inspectStoredRar(input);
  if (!mapping) return null;
  const token = randomUUID();
  let closed = false, closing, idle, refs = 0, failure = null, verification;
  const verificationController = new AbortController();
  const server = createServer((req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    void (async () => {
      if (req.url !== `/${token}/video` || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); return res.end(); }
      if (closed || failure) throw failure || new Error('Archive source closed');
      const range = archiveByteRange(req.headers.range, mapping.size);
      if (!range) { res.writeHead(416, { 'content-range': `bytes */${mapping.size}` }); return res.end(); }
      const { start, end, partial } = range;
      res.writeHead(partial ? 206 : 200, { 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream', ...(partial ? { 'content-range': `bytes ${start}-${end}/${mapping.size}` } : {}) });
      if (req.method === 'HEAD') return res.end();
      for (const part of mapping.parts) {
        if (part.videoEnd <= start || part.videoStart > end || controller.signal.aborted) continue;
        const first = Math.max(start, part.videoStart), last = Math.min(end, part.videoEnd - 1);
        for (let at = first; at <= last && !controller.signal.aborted; at += 2 * 1024 * 1024) {
          const stop = Math.min(last, at + 2 * 1024 * 1024 - 1);
          const bytes = await input.read(part.archiveStart + at - part.videoStart, part.archiveStart + stop - part.videoStart, controller.signal);
          if (bytes.length !== stop - at + 1) throw new Error('Incomplete stored RAR video range');
          if (!res.write(bytes)) await waitForDrain(res);
        }
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
  function expire(ttl = idleMs) { clearTimeout(idle); idle = setTimeout(() => void close().catch(() => {}), ttl); idle.unref(); }
  function close() {
    if (closing) return closing;
    closed = true; clearTimeout(idle); verificationController.abort(); server.closeAllConnections();
    closing = Promise.all([input.close(), new Promise(resolve => server.close(resolve)), verification?.catch(() => {})]).then(() => {});
    return closing;
  }
  expire();
  const url = `http://127.0.0.1:${server.address().port}/${token}/video`;
  return { metadata: { name: mapping.name, size: mapping.size }, completion: Promise.resolve(),
    get consumers() { return refs; }, get closed() { return closed; }, get failure() { return failure; },
    get available() { return mapping.size; }, get complete() { return true; }, randomAccess: true,
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
