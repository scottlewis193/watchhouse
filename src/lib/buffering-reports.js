// Keep reporting independent of recovery: a failed upload must never stop video.
export function createBufferingReporter({ capture, send, now = Date.now, delayMs = 3000, schedule = setTimeout, cancel = clearTimeout }) {
  let active = null, sequence = 0;
  const safeCapture = () => { try { return capture(); } catch { return null; } };
  function publish(incident, outcome, details = {}) {
    const current = safeCapture();
    const report = current?.source === incident.initial.source ? current : incident.initial;
    try {
      void Promise.resolve(send({ ...report, incident: {
        id: incident.id, startedAt: incident.startedAt,
        durationMs: Math.max(0, now() - incident.startedAt), outcome, trigger: incident.trigger, ...details,
        snapshot: incident.initial.snapshot, precedingSamples: incident.initial.samples
      } })).catch(() => {});
    } catch { /* Diagnostic persistence is best effort. */ }
  }
  return {
    start(trigger) {
      const initial = safeCapture();
      if (!initial?.jobId) return;
      if (active?.initial.source === initial.source) return;
      this.finish('source-changed');
      const incident = active = { initial: structuredClone(initial), startedAt: now(), trigger, reported: false, id: `${initial.jobId}:${now()}:${++sequence}` };
      incident.timer = schedule(() => { incident.reported = true; publish(incident, 'buffering'); }, delayMs);
    },
    finish(outcome = 'recovered', details = {}) {
      if (!active) return;
      const incident = active; active = null; cancel(incident.timer);
      if (incident.reported || outcome === 'interrupted') publish(incident, outcome, details);
    }
  };
}

export function bufferingReportPayload(report, jobId) {
  const { releaseSelection, ...job } = report.job || {};
  const { intervals, ...frameTiming } = report.frameTiming || {};
  return { ...report, jobId, job: { ...job, events: (job.events || []).slice(-20) }, frameTiming, samples: report.samples.slice(-15),
    events: report.events.slice(-20), interruptions: report.interruptions.slice(-1) };
}
