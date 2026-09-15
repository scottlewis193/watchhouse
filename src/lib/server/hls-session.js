import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function hlsOutputArgs(mp4Args, directory) {
  const outputOptions = mp4Args.indexOf('-movflags');
  if (outputOptions < 0) throw new Error('Missing conversion output options.');
  return [...mp4Args.slice(0, outputOptions), '-f', 'hls', '-hls_time', '4',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'temp_file',
    '-hls_segment_filename', join(directory, 'segment-%06d.m4s'), join(directory, 'index.m3u8')];
}

function playlistCoversExpectedDuration(bytes, expectedDuration) {
  if (!Number.isFinite(expectedDuration) || expectedDuration <= 0) return false;
  const playlist = bytes.toString();
  if (!/^#EXT-X-ENDLIST\s*$/m.test(playlist)) return false;
  const durations = [...playlist.matchAll(/^#EXTINF:([\d.]+)/gm)].map(match => Number(match[1])).filter(Number.isFinite);
  if (!durations.length) return false;
  const targetDuration = Number(playlist.match(/^#EXT-X-TARGETDURATION:([\d.]+)/m)?.[1]) || 0;
  const tolerance = Math.max(0.5, Math.min(targetDuration, 5));
  return durations.reduce((total, duration) => total + duration, 0) >= expectedDuration - tolerance;
}

export async function createHlsSession({ root, produce, idleMs = 180000, onClose = () => {} }) {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'hls-'));
  let producer;
  try { producer = await produce(directory); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  let failure = null, completed = false, closed = false, closing, timer;
  void producer.completion.then(() => { completed = true; }, error => { failure = error; });
  function touch() {
    if (closed) throw new Error('Playback session has closed.');
    clearTimeout(timer);
    timer = setTimeout(() => { void close().catch(() => {}); }, idleMs);
    timer.unref();
  }
  function close() {
    if (closing) return closing;
    closed = true; clearTimeout(timer);
    closing = (async () => {
      try { await producer.stop(); }
      finally { await rm(directory, { recursive: true, force: true }); onClose(); }
    })();
    return closing;
  }
  async function read(asset) {
    if (!/^(index\.m3u8|init\.mp4|segment-\d{6,}\.m4s)$/.test(asset)) throw new Error('Invalid playback asset.');
    touch();
    const bytes = await readFile(join(directory, asset));
    if (asset !== 'index.m3u8') return bytes;
    if (failure && !playlistCoversExpectedDuration(bytes, producer.expectedDuration)) throw failure;
    // FFmpeg can write ENDLIST while unwinding a failed input. Until its
    // completion succeeds, keep the player polling rather than ending early.
    // A late failure is safe only when the finalized playlist already covers
    // the duration left after the requested resume position.
    return completed || failure ? bytes : Buffer.from(bytes.toString().replace(/^#EXT-X-ENDLIST\r?\n?/gm, ''));
  }
  async function ready({ progress = () => 0, maxWaitMs = 45000 } = {}) {
    const started = Date.now(), limit = started + Math.max(45000, maxWaitMs);
    let deadline = started + 45000, previousProgress = progress();
    while (Date.now() < limit) {
      const currentProgress = progress();
      if (currentProgress > previousProgress) {
        previousProgress = currentProgress;
        deadline = Date.now() + 45000;
      }
      if (Date.now() >= deadline) break;
      if (closed) throw new Error('Playback session has closed.');
      try {
        const playlist = await read('index.m3u8');
        if (playlist.includes('#EXTINF:')) return;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (failure) throw failure;
      }
      await delay(100);
    }
    throw new Error('Timed out preparing playback segments.');
  }
  touch();
  return { directory, ready, read, touch, close };
}
