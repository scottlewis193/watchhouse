const SAMPLE_TTL_MS = 10 * 60 * 1000;
const MIN_SAMPLE_BYTES = 512 * 1024;

// This is a hint about the current provider, not a property of a release.
// A rolling median resists both a single slow startup and one unusually fast
// cached or bursty read without pinning every candidate to an old outlier.
export function createProviderSpeedMeter({ now = Date.now } = {}) {
  const samples = new Map();
  const key = settings => JSON.stringify([settings.usenetHost, settings.usenetPort || 563, settings.usenetUser, settings.maxConnections || 4]);
  return {
    record(settings, bytes, elapsedMs) {
      if (!settings.usenetHost || bytes < MIN_SAMPLE_BYTES || elapsedMs < 100) return;
      const id = key(settings), at = now();
      const rate = bytes * 1000 / elapsedMs;
      const recent = (samples.get(id) || []).filter(sample => at - sample.at < SAMPLE_TTL_MS);
      recent.push({ rate, at });
      samples.set(id, recent.slice(-5));
    },
    rate(settings) {
      const rates = (samples.get(key(settings)) || [])
        .filter(sample => now() - sample.at < SAMPLE_TTL_MS)
        .map(sample => sample.rate)
        .sort((a, b) => a - b);
      return rates.length ? rates[Math.floor((rates.length - 1) / 2)] : null;
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
