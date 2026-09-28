import { redactPlaybackReport } from '../playback-trace.js';

// One JSON line per event lets Docker capture and operators correlate jobs.
export function logPlaybackEvent(job, activity, message, details = {}, write = console.log) {
  try {
    const event = redactPlaybackReport({
      ...details, at: new Date().toISOString(), component: 'playback',
      jobId: job.id, activity, message, mode: job.mode, strategy: job.strategy
    });
    write(JSON.stringify(event));
  } catch { /* Logging must not interrupt playback. */ }
}
