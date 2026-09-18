import { mkdir, mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function hlsOutputArgs(mp4Args, directory, segmentSeconds = 4) {
  if (![2, 4].includes(segmentSeconds)) throw new Error('Playback segment duration must be two or four seconds.');
  const outputOptions = mp4Args.indexOf('-movflags');
  if (outputOptions < 0) throw new Error('Missing conversion output options.');
  return [...mp4Args.slice(0, outputOptions), '-f', 'hls', '-hls_time', String(segmentSeconds),
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

let activeSessions = 0;

export async function createHlsSession({ root, produce, idleMs = 180000, onClose = () => {}, maxSessions = 4, maxBytes = 8 * 1024 ** 3, checkMs = 5000 }) {
  if (activeSessions >= maxSessions) throw Object.assign(new Error('All playback conversion slots are in use. Try again shortly.'), { code: 'PLAYBACK_BUSY' });
  activeSessions++;
  let released = false;
  const release = () => { if (!released) { released = true; activeSessions--; } };
  let directory;
  try {
    await mkdir(root, { recursive: true });
    directory = await mkdtemp(join(root, 'hls-'));
    let producer;
    try { producer = await produce(directory); }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    let failure = null, completed = false, closed = false, closing, timer, monitor, bytes = 0, paused = false, position = 0, checking = false;
    void producer.completion.then(() => { completed = true; }, error => { failure = error; });
    function touch() {
      if (closed) throw new Error('Playback session has closed.');
      clearTimeout(timer);
      timer = setTimeout(() => { void close().catch(() => {}); }, idleMs);
      timer.unref();
    }
    function close() {
      if (closing) return closing;
      closed = true; clearTimeout(timer); clearInterval(monitor);
      closing = (async () => {
        try { await producer.stop(); }
        finally {
          try { await rm(directory, { recursive: true, force: true }); }
          finally { release(); onClose(); }
        }
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
    function playbackState(state = {}) {
      if (typeof state.paused === 'boolean') paused = state.paused;
      if (Number.isFinite(state.position) && state.position >= 0) position = state.position;
      const ahead = Math.max(0, (producer.position?.() || 0) - position);
      producer.setPaused?.(paused || ahead >= 90);
    }
    async function checkResources() {
      if (checking || closed) return;
      checking = true;
      try {
        playbackState();
        const names = await readdir(directory);
        const sizes = await Promise.all(names.map(name => stat(join(directory, name)).then(info => info.size, () => 0)));
        bytes = sizes.reduce((total, size) => total + size, 0);
        if (bytes > maxBytes) {
          failure = Object.assign(new Error('Playback temporary storage limit reached. Resume with a new session.'), { code: 'PLAYBACK_STORAGE_LIMIT' });
          await close();
        }
      } catch (error) { if (!closed) failure = error; }
      finally { checking = false; }
    }
    monitor = setInterval(() => void checkResources(), checkMs);
    monitor.unref();
    touch();
    return { directory, ready, read, touch, close, playbackState,
      health: () => ({ failed: Boolean(failure), closed, completed, bytes, paused, position: producer.position?.() || 0 }) };
  } catch (error) { release(); if (directory) await rm(directory, { recursive: true, force: true }); throw error; }
}
