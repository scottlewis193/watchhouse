// Observe work the live source actually completes. These rates are diagnostic:
// playback may pause or stop asking for articles, so neither is a speed-test cap.
export function createArticleDeliveryMeter(onSample, { now = () => performance.now(), intervalMs = 5000, idleMs = 10000 } = {}) {
  let started = null, last = null, bytes = 0, articles = 0;
  const flush = () => {
    const elapsedMs = last - started;
    if (started !== null && elapsedMs >= 1000 && bytes >= 512 * 1024) {
      onSample({ bytes, articles, elapsedMs, bytesPerSecond: bytes * 1000 / elapsedMs });
    }
    started = last = null; bytes = articles = 0;
  };
  return {
    record(size) {
      if (!Number.isFinite(size) || size <= 0) return;
      const at = now();
      if (started === null || at - last > idleMs) {
        started = last = at; bytes = articles = 0;
        return; // Exclude the first article's connection and setup time.
      }
      last = at; bytes += size; articles++;
      if (at - started >= intervalMs) flush();
    },
    flush
  };
}

export function createVideoOutputMeter(onSample, { now = () => performance.now(), intervalMs = 10000 } = {}) {
  let started = null, first = 0;
  return {
    record(position, paused = false) {
      if (paused || !Number.isFinite(position)) { started = null; return; }
      const at = now();
      if (started === null || position < first) { started = at; first = position; return; }
      const elapsedMs = at - started;
      if (elapsedMs < intervalMs) return;
      const producedSeconds = Math.max(0, position - first);
      onSample({ producedSeconds, elapsedMs, viewingSpeed: producedSeconds * 1000 / elapsedMs });
      started = at; first = position;
    }
  };
}
