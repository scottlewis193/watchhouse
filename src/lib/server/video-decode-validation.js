import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { conversionAdmission } from './conversion-admission.js';
const execute = promisify(execFile);

// Packet timestamps alone cannot catch broken H.264 reference frames.
// Check a bounded opening interval before trusting a complete offline source.
export async function validateOpeningVideoDecode(path, signal) {
  const release = await conversionAdmission.acquire({ signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
  try {
    const { stderr } = await execute('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-threads', '2', '-i', path, '-t', '20', '-map', '0:v:0', '-an', '-f', 'null', '-'], { signal, timeout: 30000, maxBuffer: 1024 * 1024 });
    // Some demuxer errors are logged at error level without a nonzero exit.
    if (stderr.trim()) throw Object.assign(new Error(stderr), { code: 1 });
  } catch (cause) {
    if (typeof cause.code !== 'number') throw cause;
    throw Object.assign(new Error('This saved video contains damaged data in its opening frames. Trying another release.', { cause }), { code: 'INVALID_MEDIA_DECODE' });
  } finally { release(); }
}
