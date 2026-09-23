const SAMPLE_TTL_MS = 10 * 60 * 1000;
const MIN_SAMPLE_BYTES = 512 * 1024;

// This is a hint about the current provider, not a property of a release.
// Keep the slowest recent observation so a short cached or bursty read cannot
// make a large release appear safe to stream.
export function createProviderSpeedMeter({ now = Date.now } = {}) {
  const samples = new Map();
  const key = settings => JSON.stringify([settings.usenetHost, settings.usenetPort || 563, settings.usenetUser, settings.maxConnections || 4]);
  return {
    record(settings, bytes, elapsedMs) {
      if (!settings.usenetHost || bytes < MIN_SAMPLE_BYTES || elapsedMs < 100) return;
      const id = key(settings), previous = samples.get(id);
      const rate = bytes * 1000 / elapsedMs;
      const inWindow = previous && now() - previous.windowStart < SAMPLE_TTL_MS;
      samples.set(id, { rate: inWindow ? Math.min(previous.rate, rate) : rate, at: now(), windowStart: inWindow ? previous.windowStart : now() });
    },
    rate(settings) {
      const sample = samples.get(key(settings));
      return sample && now() - sample.at < SAMPLE_TTL_MS ? sample.rate : null;
    }
  };
}

export function candidatePlaybackDemand(file, durationSeconds, safetyFactor = 1.5) {
  const bytes = file?.segments?.reduce((total, segment) => total + Number(segment.decodedBytes || segment.bytes || 0), 0);
  if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  return bytes / durationSeconds * safetyFactor;
}

export function candidateNeedsMoreSpeed(file, durationSeconds, bytesPerSecond, safetyFactor = 1.5) {
  const demand = candidatePlaybackDemand(file, durationSeconds, safetyFactor);
  return demand !== null && Number.isFinite(bytesPerSecond) && bytesPerSecond > 0 && demand > bytesPerSecond;
}
