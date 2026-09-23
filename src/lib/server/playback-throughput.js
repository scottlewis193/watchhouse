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

// FFmpeg's output clock can jump across missing media while producing only a
// handful of frames. A speed sample alone mistakes that jump for fast output.
export function createVideoTimelineGuard({ frameRate = 25, start = 0 } = {}) {
  let previous = null;
  const minimumFps = Math.max(1, Math.min(5, Number(frameRate) / 3 || 5));
  return {
    record(frame, position) {
      if (!Number.isFinite(frame) || frame < 0 || !Number.isFinite(position) || position < 0) return null;
      const baseline = previous || { frame: 0, position: start > 0 ? position : 0 };
      const elapsedSeconds = position - baseline.position;
      const frames = frame - baseline.frame;
      previous = { frame, position };
      if (elapsedSeconds < 12 || frames < 0 || frames >= elapsedSeconds * minimumFps) return null;
      return { elapsedSeconds, frames };
    }
  };
}
