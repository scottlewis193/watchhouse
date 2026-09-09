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
  let source = null, samples = [], interruptions = [];
  return {
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
