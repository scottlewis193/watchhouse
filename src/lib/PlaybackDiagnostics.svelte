<script>
  let { playback = null, nextJob = null, video = null } = $props();

  function time(value) {
    return value ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '—';
  }
  function stateLabel(value, labels) { return labels[value] || String(value ?? '—'); }
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

<details class="playback-diagnostics mt-5 border-y border-base-300">
  <summary class="cursor-pointer py-4 text-xs font-semibold uppercase tracking-[0.16em] text-base-content/60">Playback diagnostics</summary>
  <div class="grid gap-8 border-t border-base-300 py-5 text-xs lg:grid-cols-2">
    <section>
      <h3 class="font-semibold uppercase tracking-[0.12em] text-base-content/55">Active playback</h3>
      <dl class="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt class="text-base-content/50">Job</dt><dd class="break-all font-mono">{playback?.id || '—'}</dd>
        <dt class="text-base-content/50">Activity</dt><dd>{playback?.status || '—'} · {playback?.message || '—'}</dd>
        <dt class="text-base-content/50">Media</dt><dd>{playback?.diagnostics?.media || '—'}</dd>
        <dt class="text-base-content/50">Release</dt><dd class="break-words">{playback?.diagnostics?.release || 'Not selected yet'}</dd>
        <dt class="text-base-content/50">Pipeline</dt><dd>{playback?.diagnostics?.mode || '—'} / {playback?.diagnostics?.strategy || '—'}</dd>
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
        <dt class="text-base-content/50">Buffered</dt><dd>{video?.buffered || '—'}</dd>
        <dt class="text-base-content/50">Error</dt><dd>{video?.error || 'None'}</dd>
      </dl>
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
