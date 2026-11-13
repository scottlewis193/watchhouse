import { redactPlaybackReport } from './playback-trace.js';

// A report is evidence, never a playback dependency. One attempt spans source retries.
export function createStartupReporter({ capture, send, now = () => performance.now(), wallNow = Date.now,
  schedule = setTimeout, cancel = clearTimeout, targetMs = 10000,
  identify = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}:${Math.random().toString(36).slice(2)}` }) {
  let active = null;
  function publish(attempt, outcome, details = {}) {
    try {
      let current;
      try { current = capture(); } catch { current = null; }
      const evidence = attempt.jobId && current?.jobId === attempt.jobId ? current : {};
      const durationMs = Math.max(0, now() - attempt.clock);
      const report = redactPlaybackReport({ ...evidence, media: attempt.media, jobId: attempt.jobId,
        events: attempt.events.slice(), incident: { kind: 'startup', id: attempt.id,
          startedAt: attempt.startedAt, durationMs, targetMs, metTarget: outcome === 'playing' ? durationMs <= targetMs : null,
          stage: attempt.stage, outcome, ...details } });
      void Promise.resolve(send(report)).catch(() => {});
    } catch { /* Diagnostic failures must not interrupt selection or playback. */ }
  }
  function stage(value, details = {}) {
    if (!active || active.stage === value) return;
    active.stage = value;
    active.events.push({ at: wallNow(), type: value, ...details });
    if (active.events.length > 40) active.events.shift();
  }
  function finish(outcome, details = {}) {
    if (!active) return;
    const attempt = active;
    active = null;
    cancel(attempt.timer);
    publish(attempt, outcome, details);
  }
  return {
    start(media) {
      finish('cancelled', { reason: 'superseded' });
      // Never send release URLs or provider credentials as selection metadata.
      const { id, type, title, season, episode, releaseId } = media;
      const attempt = active = { id: identify(), media: { id, type, title, season, episode, releaseId },
        jobId: null, startedAt: wallNow(), clock: now(), stage: 'selecting', events: [] };
      stage('requesting-release');
      publish(attempt, 'started');
      attempt.timer = schedule(() => { if (active === attempt) publish(attempt, 'slow'); }, targetMs);
    },
    job(job) {
      if (!active) return;
      const attached = job.id && active.jobId !== job.id;
      if (active.jobStatus !== job.status) {
        active.jobStatus = job.status;
        stage(job.status === 'ready' ? 'source-ready' : job.status, { message: job.message });
      }
      if (job.id) active.jobId = job.id;
      if (['error', 'cancelled'].includes(job.status)) finish(job.status === 'error' ? 'failed' : 'cancelled', { message: job.message });
      else if (attached) publish(active, 'started');
    },
    stage,
    finish
  };
}
