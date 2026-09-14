import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

// Older packaged FFmpeg versions lack initial-burst pacing. Detect support
// once and retain their existing input pacing instead of breaking playback.
export function createHlsPacing(readHelp = async () => (await execute('ffmpeg', ['-hide_banner', '-h', 'full'], { maxBuffer: 4 * 1024 * 1024 })).stdout) {
  let options;
  return async () => {
    options ||= Promise.resolve().then(readHelp).then(help => [
      '-readrate', '1.5', ...(/-readrate_initial_burst\b/.test(help) ? ['-readrate_initial_burst', '8'] : [])
    ]).catch(() => ['-readrate', '1.5']);
    return [...await options];
  };
}
