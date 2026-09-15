// Progress is completed milestones, not an estimate of the remaining time.
export const playbackSetupStages = ['Opening video and audio', 'Preparing the first playable segment', 'Loading the video buffer', 'Starting playback'];
export function playbackSetupProgress(completed, details = {}) {
  const count = Math.min(4, Math.max(0, Math.floor(Number(completed) || 0)));
  const suppliedPercent = Number(details.percent);
  return {
    completed: count,
    total: 4,
    percent: Number.isFinite(suppliedPercent) ? Math.min(100, Math.max(0, suppliedPercent)) : count * 25,
    message: typeof details.message === 'string' && details.message.trim() ? details.message : playbackSetupStages[count] || 'Playback ready',
    ...(typeof details.detail === 'string' && details.detail.trim() ? { detail: details.detail } : {})
  };
}

export async function readPlaybackSetup(response, onProgress) {
  if (!response.headers?.get('content-type')?.includes('application/x-ndjson')) return response.json();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', session;
  function consume(line) {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') throw new Error(event.error);
    if (event.type === 'progress') onProgress?.(playbackSetupProgress(event.completed, event));
    if (event.type === 'ready') session = event.session;
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) { consume(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
      if (done) break;
    }
    consume(pending);
    if (!session) throw new Error('Playback preparation ended before the video was ready.');
    return session;
  } finally { reader.releaseLock(); }
}
