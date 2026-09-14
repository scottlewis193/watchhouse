import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

// Older packaged FFmpeg versions lack initial-burst pacing. Detect support
// once and retain their existing input pacing instead of breaking playback.
export function createHlsPacing(readHelp = async () => (await execute('ffmpeg', ['-hide_banner', '-h', 'full'], { maxBuffer: 4 * 1024 * 1024 })).stdout) {
  let options;
  return async (discardSeconds = 0) => {
    options ||= Promise.resolve().then(readHelp).then(help => [
      '-readrate', '1.5', ...(/-readrate_initial_burst\b/.test(help) ? ['-readrate_initial_burst', '8'] : [])
    ]).catch(() => ['-readrate', '1.5']);
    const pacing = [...await options];
    const burst = pacing.indexOf('-readrate_initial_burst');
    // Output-side seeking still reads the discarded prefix. Let it pass at
    // full speed, then pace the retained video with the usual startup buffer.
    if (burst >= 0 && Number.isFinite(discardSeconds) && discardSeconds > 0) {
      pacing[burst + 1] = String(discardSeconds + 8);
    }
    return pacing;
  };
}
