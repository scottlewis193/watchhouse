const finite = value => Number.isFinite(value) ? value : null;

export function playbackTraceSample(player, offset = 0, at = Date.now()) {
  const quality = player?.getVideoPlaybackQuality?.();
  const buffered = Array.from({ length: player?.buffered?.length || 0 }, (_, index) => ({
    start: player.buffered.start(index), end: player.buffered.end(index)
  }));
  const currentTime = finite(player?.currentTime);
  const range = buffered.find(range => range.start <= currentTime && currentTime < range.end);
  return {
    at, currentTime, position: currentTime === null ? null : currentTime + offset,
    duration: finite(player?.duration), offset, buffered,
    bufferedAhead: range ? range.end - currentTime : 0,
    readyState: player?.readyState ?? null, networkState: player?.networkState ?? null,
    paused: player?.paused ?? null, seeking: player?.seeking ?? null, ended: player?.ended ?? null,
    muted: player?.muted ?? null, volume: finite(player?.volume), playbackRate: finite(player?.playbackRate),
    audioDecodedBytes: finite(player?.webkitAudioDecodedByteCount),
    videoFrames: finite(quality?.totalVideoFrames ?? player?.webkitDecodedFrameCount),
    droppedFrames: finite(quality?.droppedVideoFrames ?? player?.webkitDroppedFrameCount),
    errorCode: player?.error?.code ?? null
  };
}

export function createPlaybackTrace() {
  let source = null, samples = [], interruptions = [], events = [];
  const started = Date.now();
  return {
    event(type, details = {}) { events = [...events, { at: Date.now(), type, ...structuredClone(details) }].slice(-100); },
    report(details = {}) { return redactPlaybackReport({ version: 2, metrics: playbackMetrics(events), started, exported: Date.now(), source, samples, events, interruptions, ...details }); },
    sample(sourceId, sample) {
      if (source !== sourceId) { source = sourceId; samples = []; }
      if (!samples.length || sample.at - samples.at(-1).at >= 1000) {
        samples = [...samples, structuredClone(sample)].slice(-30);
      }
    },
    interrupt(sourceId, details, sample) {
      if (source !== sourceId) { source = sourceId; samples = []; }
      // Copy before the player is replaced and its counters/buffers are reset.
      interruptions = [...interruptions, structuredClone({ ...details, at: sample.at, snapshot: sample, samples })].slice(-20);
      return structuredClone(interruptions);
    }
  };
}

// Exports stay local. Remove private URL paths and credential-shaped fields.
export function redactPlaybackReport(value) {
  if (Array.isArray(value)) return value.map(redactPlaybackReport);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /password|passwd|secret|token|api.?key|authorization|cookie/i.test(key) ? '<REDACTED>' : redactPlaybackReport(item)]));
  if (typeof value === 'string') return value.replace(/https?:\/\/[^\s"'<>]+/gi, '<REDACTED_URL>');
  return value;
}

export function playbackMetrics(events) {
  let requestAt = null, waitingAt = null;
  const starts = [], waits = [];
  for (const event of events) {
    if (event.type === 'source-request') requestAt = event.at;
    if (event.type === 'buffering-start' && !event.startup && waitingAt === null) waitingAt = event.at;
    if (event.type === 'advancing-frame') {
      if (requestAt !== null) { starts.push(Math.max(0, event.at - requestAt)); requestAt = null; }
    }
    if (['buffering-end', 'advancing-frame'].includes(event.type) && waitingAt !== null) { waits.push(Math.max(0, event.at - waitingAt)); waitingAt = null; }
  }
  return { sourceToAdvanceMs: starts, rebufferCount: waits.length + Number(waitingAt !== null), completedRebufferMs: waits.reduce((a,b)=>a+b,0), rebufferDurationsMs: waits };
}
