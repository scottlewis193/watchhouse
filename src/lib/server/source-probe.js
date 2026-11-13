import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

const entries = 'format=duration:stream=index,codec_type,codec_name,r_frame_rate,avg_frame_rate:stream_tags=language,title,handler_name';

// Shortened analysis cannot prove that a later audio stream was not omitted.
// Reuse only standard-probe metadata for the same verified byte identity instead.
function articleIdentity(source) {
  if (!Array.isArray(source?.segments) || !source.segments.length) return null;
  const hash = createHash('sha256');
  for (const segment of source.segments) {
    if (typeof segment.id !== 'string' || !segment.id.trim() || !Number.isSafeInteger(segment.decodedBytes) || segment.decodedBytes <= 0) return null;
    hash.update(JSON.stringify([segment.id, segment.decodedBytes]));
  }
  return `articles:${hash.digest('hex')}`;
}

function storedArchiveIdentity(archives, archiveSource) {
  const metadata = archiveSource?.metadata;
  if (!archiveSource?.randomAccess || !archiveSource.complete || archiveSource.closed || archiveSource.failure
    || typeof metadata?.name !== 'string' || !metadata.name || !Number.isSafeInteger(metadata.size) || metadata.size <= 0
    || !Array.isArray(archives) || !archives.length) return null;
  const hash = createHash('sha256').update(JSON.stringify([metadata.name, metadata.size]));
  for (const file of archives) {
    if (!Array.isArray(file?.segments) || !file.segments.length) return null;
    hash.update('volume:');
    for (const segment of file.segments) {
      if (typeof segment.id !== 'string' || !segment.id.trim()) return null;
      hash.update(JSON.stringify([segment.id, segment.number, segment.decodedBytes ?? segment.bytes ?? null]));
    }
  }
  return `stored-rar:${hash.digest('hex')}`;
}

async function contentIdentity(input, source, archives, archiveSource) {
  // A stored RAR has already verified every volume header and member mapping.
  // Compressed/progressive extraction, even when complete, stays uncached.
  if (archiveSource) return storedArchiveIdentity(archives, archiveSource);
  if (typeof input !== 'string') return null;
  // URLs are not identities: range-server ports are transient. Published NNTP
  // articles are immutable, but a downloaded/optimized local copy is a separate
  // file version even if its job still carries the original article manifest.
  if (/^[a-z][a-z\d+.-]*:/i.test(input)) return articleIdentity(source);
  const info = await stat(input, { bigint: true }).catch(() => null);
  if (!info?.isFile()) return null;
  return `file:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

// execute(args) must run ffprobe and return its JSON stdout. Its owner retains
// process cancellation/timeouts. source is only a direct, verified yEnc layout.
// archives must use the same volume order used to open archiveSource; article
// message IDs identify immutable published bytes, not transient range URLs.
export function createSourceProbe({ maximumEntries = 64, maximumBytes = 1024 * 1024 } = {}) {
  const cache = new Map();
  let bytes = 0;
  const remove = key => {
    const cached = cache.get(key);
    if (!cached) return;
    cache.delete(key);
    bytes -= cached.bytes;
  };
  return async function probeSource({ input, execute, signal, source, archives, archiveSource, scope = '', readTimeout = '15000000', inputOptions = [], combined = false }) {
    signal?.throwIfAborted();
    // Packet scans remain fresh: cache hits must never replace the twenty-second
    // timeline check, nor delay ordinary paths' early metadata publication.
    const identity = combined ? null : await contentIdentity(input, source, archives, archiveSource);
    signal?.throwIfAborted();
    const key = identity && JSON.stringify([identity, scope, inputOptions]);
    const cached = key && cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return JSON.parse(cached.output);
    }
    const inspect = options => execute(['-v', 'error', '-rw_timeout', readTimeout,
      // Seeking to zero on a non-seekable input can discard packets buffered
      // during stream analysis. Start from those packets, not the later cursor.
      ...(combined ? ['-read_intervals', options[options.indexOf('-seekable') + 1] === '0' ? '%+20' : '0%+20', '-show_packets'] : []),
      '-show_entries', entries + (combined ? ':packet=stream_index,dts_time' : ''),
      '-of', 'json', ...options, input]);
    const linear = inputOptions.length === 0 && /^https?:\/\//i.test(input)
      && /\.mkv(?:["\s]|$)/i.test(archiveSource?.metadata?.name || source?.subject || '');
    let output, result;
    if (linear) {
      try {
        output = await inspect(['-seekable', '0']);
        signal?.throwIfAborted();
        result = JSON.parse(output);
        if (!(Number(result.format?.duration) > 0) || !Array.isArray(result.streams)
          || !result.streams.some(stream => stream.codec_type === 'video')
          || !result.streams.every(stream => Number.isInteger(stream.index) && stream.codec_name)
          || combined && !result.packets?.length) result = null;
      } catch { signal?.throwIfAborted(); }
    }
    // A mislabeled or seek-dependent container retains the standard probe.
    if (!result) {
      output = await inspect(inputOptions);
      signal?.throwIfAborted();
      result = JSON.parse(output);
    }
    const size = Buffer.byteLength(output);
    if (key && maximumEntries > 0 && size <= maximumBytes && Array.isArray(result.streams) && result.streams.length
      && result.streams.every(stream => Number.isInteger(stream.index) && stream.index >= 0 && stream.codec_type && stream.codec_name)
      && await contentIdentity(input, source, archives, archiveSource) === identity) {
      signal?.throwIfAborted();
      remove(key);
      while (cache.size && (cache.size >= maximumEntries || bytes + size > maximumBytes)) remove(cache.keys().next().value);
      cache.set(key, { output, bytes: size });
      bytes += size;
    }
    signal?.throwIfAborted();
    return result;
  };
}

export const probePlaybackSource = createSourceProbe();
