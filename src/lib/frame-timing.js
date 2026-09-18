// Frame callbacks are best-effort compositor observations, not proof of screen delivery.
export function createFrameTimingCollector() {
  let previous = null, intervals = [];
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  };
  return {
    reset() { previous = null; intervals = []; },
    breakSequence() { previous = null; },
    add(now, metadata) {
      const current = { display: metadata.expectedDisplayTime, media: metadata.mediaTime * 1000, frames: metadata.presentedFrames };
      if (![current.display, current.media, current.frames, now].every(Number.isFinite)) { previous = null; return; }
      if (previous && current.display > previous.display && current.media > previous.media && current.frames > previous.frames) {
        intervals.push({ at: current.display, displayMs: current.display - previous.display, sourceMs: current.media - previous.media, frames: current.frames - previous.frames, callbackLateMs: Math.max(0, now - current.display) });
        intervals = intervals.filter(sample => sample.at >= current.display - 10000);
      }
      intervals = intervals.slice(-600);
      previous = current;
    },
    summary() {
      // Missed callbacks do not imply missing video frames. Exclude multi-frame intervals.
      const consecutive = intervals.filter(sample => sample.frames === 1);
      const display = consecutive.map(sample => sample.displayMs), source = consecutive.map(sample => sample.sourceMs);
      const displayMedianMs = median(display), sourceMedianMs = median(source);
      return {
        supported: true, samples: consecutive.length, displayMedianMs, displayMaxMs: display.length ? Math.max(...display) : null,
        sourceMedianMs, sourceMaxMs: source.length ? Math.max(...source) : null,
        longDisplayIntervals: displayMedianMs ? display.filter(value => value > displayMedianMs * 2.5).length : 0,
        skippedCallbacks: intervals.reduce((total, sample) => total + sample.frames - 1, 0),
        callbackLateMaxMs: intervals.length ? Math.max(...intervals.map(sample => sample.callbackLateMs)) : null,
        intervals: intervals.slice(-60)
      };
    }
  };
}

export function frameTiming(video, initial) {
  const collector = createFrameTimingCollector(), doc = video.ownerDocument;
  let options = initial, key = initial.key, handle = null, lastPublished = -Infinity, closed = false;
  const publish = state => options.onSample?.({ ...collector.summary(), state });
  const stop = state => {
    if (handle !== null) video.cancelVideoFrameCallback?.(handle);
    handle = null; collector.breakSequence(); publish(state);
  };
  const callback = (now, metadata) => {
    handle = null;
    if (closed || video.paused || video.seeking || doc.hidden) return;
    collector.add(now, metadata);
    if (now - lastPublished >= 1000) { lastPublished = now; publish('measuring'); }
    handle = video.requestVideoFrameCallback(callback);
  };
  const start = () => {
    if (!closed && handle === null && !video.paused && !video.seeking && !doc.hidden) handle = video.requestVideoFrameCallback(callback);
  };
  if (typeof video.requestVideoFrameCallback !== 'function') {
    options.onSample?.({ supported: false, state: 'unsupported' });
    return { update(next) { options = next; }, destroy() {} };
  }
  const listeners = { playing: start, seeked: start, pause: () => stop('paused'), seeking: () => { collector.reset(); stop('seeking'); }, waiting: () => stop('buffering'), emptied: () => { collector.reset(); stop('measuring'); }, ratechange: () => { collector.reset(); stop('measuring'); start(); } };
  const visibility = () => { collector.reset(); stop(doc.hidden ? 'hidden' : 'measuring'); start(); };
  for (const [event, listener] of Object.entries(listeners)) video.addEventListener(event, listener);
  doc.addEventListener('visibilitychange', visibility);
  publish('measuring'); start();
  return {
    update(next) {
      options = next;
      if (next.key !== key) { key = next.key; collector.reset(); lastPublished = -Infinity; stop('measuring'); start(); }
    },
    destroy() {
      closed = true;
      if (handle !== null) video.cancelVideoFrameCallback?.(handle);
      for (const [event, listener] of Object.entries(listeners)) video.removeEventListener(event, listener);
      doc.removeEventListener('visibilitychange', visibility);
    }
  };
}
