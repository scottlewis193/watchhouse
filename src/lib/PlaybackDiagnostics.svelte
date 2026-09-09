<script>
  let { playback = null, nextJob = null, video = null, credits = null, interruptions = [], embedded = false } = $props();

  function downloadTrace() {
    const blob = new Blob([JSON.stringify({ version: 1, interruptions }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'watchhouse-playback-diagnostics.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const interruptionLabels = { 'buffering-timeout': 'Buffering timeout', 'audio-stall': 'Audio-stall check', 'media-error': 'Browser media error' };

  function time(value) {
    return value ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '—';
  }
  function stateLabel(value, labels) { return labels[value] || String(value ?? '—'); }
  function percent(value) { return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—'; }
  const readyLabels = ['Nothing', 'Metadata', 'Current data', 'Future data', 'Enough data'];
  function mediaFetchLabel(value) {
    if (value === 0) return 'Not started';
    if (value === 1) return 'Buffered / idle';
    if (value === 2) {
      if (playback?.mode === 'cached') return 'Reading saved file';
      if (playback?.mode === 'cached-convert') return 'Processing saved file';
      return 'Fetching stream';
    }
    if (value === 3) return 'No media source';
    return String(value ?? '—');
  }
</script>

<details class="playback-diagnostics mt-5 border-y border-base-300" class:playback-diagnostics-embedded={embedded} open={embedded}>
  <summary class="cursor-pointer py-4 text-xs font-semibold uppercase tracking-[0.16em] text-base-content/60" class:sr-only={embedded}>Playback diagnostics</summary>
  <div class="playback-diagnostics-content grid gap-8 border-t border-base-300 py-5 text-xs lg:grid-cols-2">
    <section>
      <h3 class="font-semibold uppercase tracking-[0.12em] text-base-content/55">Active playback</h3>
      <dl class="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt class="text-base-content/50">Job</dt><dd class="break-all font-mono">{playback?.id || '—'}</dd>
        <dt class="text-base-content/50">Activity</dt><dd>{playback?.status || '—'} · {playback?.message || '—'}</dd>
        <dt class="text-base-content/50">Media</dt><dd>{playback?.diagnostics?.media || '—'}</dd>
        <dt class="text-base-content/50">Release</dt><dd class="break-words">{playback?.diagnostics?.release || 'Not selected yet'}</dd>
        <dt class="text-base-content/50">Pipeline</dt><dd>{playback?.diagnostics?.mode || '—'} / {playback?.diagnostics?.strategy || '—'}</dd>
        <dt class="text-base-content/50">Acceleration</dt><dd>{playback?.diagnostics?.acceleration || 'Detecting…'}</dd>
        <dt class="text-base-content/50">Audio policy</dt><dd>English language/title metadata, then track {playback?.untaggedAudioTrack || 2}, then track 1</dd>
        <dt class="text-base-content/50">Next episode</dt><dd>{nextJob ? `${nextJob.status} · ${nextJob.message || 'working'}` : 'Not preparing'}</dd>
      </dl>
    </section>
    <section>
      <h3 class="font-semibold uppercase tracking-[0.12em] text-base-content/55">Browser video</h3>
      <dl class="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt class="text-base-content/50">Ready state</dt><dd>{stateLabel(video?.readyState, readyLabels)}</dd>
        <dt class="text-base-content/50">Media fetch</dt><dd>{mediaFetchLabel(video?.networkState)}</dd>
        <dt class="text-base-content/50">Playback</dt><dd>{video?.event || 'Waiting for player'}{video?.paused === false ? ' · playing' : ' · paused'}</dd>
        <dt class="text-base-content/50">Position</dt><dd>{Math.round(video?.currentTime || 0)}s / {Number.isFinite(video?.duration) ? `${Math.round(video.duration)}s` : 'unknown'}</dd>
        <dt class="text-base-content/50">Frame size</dt><dd>{video?.videoWidth && video?.videoHeight ? `${video.videoWidth} × ${video.videoHeight}` : 'Not reported'}</dd>
        <dt class="text-base-content/50">Rendered FPS</dt><dd>{Number.isFinite(video?.fps) ? `${video.fps.toFixed(1)} fps` : 'Measuring…'}</dd>
        <dt class="text-base-content/50">Video frames</dt><dd>{Number.isFinite(video?.totalFrames) ? video.totalFrames.toLocaleString() : 'Unavailable'}</dd>
        <dt class="text-base-content/50">Dropped</dt><dd>{Number.isFinite(video?.droppedFrames) ? `${video.droppedFrames.toLocaleString()} (${video.droppedFramePercent.toFixed(2)}%)` : 'Unavailable'}</dd>
        <dt class="text-base-content/50">Buffered</dt><dd>{video?.buffered || '—'}</dd>
        <dt class="text-base-content/50">Smart credits</dt><dd>{credits?.label || 'Waiting for playback data'}</dd>
        <dt class="text-base-content/50">Credit sample</dt><dd>{credits?.sample ? `dark ${percent(credits.sample.darkFraction)} · bright ${percent(credits.sample.brightFraction)} · edges ${percent(credits.sample.edgeDensity)}` : 'No frame sampled yet'}</dd>
        <dt class="text-base-content/50">Credit center</dt><dd>{credits?.sample ? `dark ${percent(credits.sample.centerDarkFraction)} · bright ${percent(credits.sample.centerBrightFraction)} · edges ${percent(credits.sample.centerEdgeDensity)}` : 'No frame sampled yet'}</dd>
        <dt class="text-base-content/50">Credit profile</dt><dd>{credits?.sample ? `${credits.sample.profile} · ${percent(credits.sample.confidence)} confidence` : 'No frame sampled yet'}</dd>
        <dt class="text-base-content/50">Credit evidence</dt><dd>{credits?.detected ? 'Detected' : `${credits?.consecutiveMatches || 0} / ${credits?.sampleCount || 0} recent frames`}</dd>
        <dt class="text-base-content/50">Error</dt><dd>{video?.error || 'None'}</dd>
      </dl>
    </section>
    <section class="lg:col-span-2">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 class="font-semibold uppercase tracking-[0.12em] text-base-content/55">Playback interruptions</h3>
        <button class="btn btn-xs" disabled={!interruptions.length} onclick={downloadTrace}>Download diagnostic report</button>
      </div>
      <p class="mt-2 text-base-content/55">Keeps the last 20 interruptions while this page is open, including player samples leading up to each one. Download before reloading or leaving the page.</p>
      {#if interruptions.length}
        <ol class="mt-3 max-h-64 space-y-4 overflow-y-auto">
          {#each [...interruptions].reverse() as interruption}
            <li>
              <p><span class="text-base-content/55">{time(interruption.at)}</span> <strong>{interruptionLabels[interruption.reason] || interruption.reason}</strong> · {interruption.action === 'retry' ? `Automatic retry ${interruption.attempt}` : interruption.action === 'offer' ? 'Recovery offered' : 'Playback error'}</p>
              <p>{interruption.media?.title}{interruption.media?.season ? ` · S${interruption.media.season}E${interruption.media.episode}` : ''} · {Math.round(interruption.snapshot.position || 0)}s</p>
              <p class="text-base-content/65">Buffer ahead: {interruption.snapshot.bufferedAhead.toFixed(1)}s · Ready: {stateLabel(interruption.snapshot.readyState, readyLabels)} · Audio bytes: {interruption.snapshot.audioDecodedBytes ?? 'unavailable'} · Error code: {interruption.snapshot.errorCode ?? 'none'}</p>
            </li>
          {/each}
        </ol>
      {:else}<p class="mt-3 text-base-content/55">No interruptions recorded on this page yet.</p>{/if}
    </section>
    <section class="lg:col-span-2">
      <h3 class="font-semibold uppercase tracking-[0.12em] text-base-content/55">Background event log</h3>
      {#if playback?.diagnostics?.events?.length}
        <ol class="mt-3 max-h-64 space-y-2 overflow-y-auto border-l border-base-300 pl-3 font-mono">
          {#each [...playback.diagnostics.events].reverse() as event}
            <li><span class="text-base-content/45">{time(event.at)}</span> <span class="text-primary">[{event.activity}]</span> {event.message}{event.release ? ` · ${event.release}` : ''}</li>
          {/each}
        </ol>
      {:else}<p class="mt-3 text-base-content/55">No server events have been reported yet.</p>{/if}
    </section>
  </div>
</details>

<style>
  .playback-diagnostics-embedded { margin: 0; border: 0; }
  .playback-diagnostics-embedded .playback-diagnostics-content { border: 0; padding: 0; }
</style>
