<script>
  let { title, message = '', progress = 0, download = null, detailed = false, error = false, indeterminate = false, artwork = '' } = $props();

  function formatBytes(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes, index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
  }
</script>

<div class="playback-preparation relative flex size-full items-end overflow-hidden" class:playback-preparation-error={error} style={`--preparation-artwork: ${artwork ? `url("${artwork}")` : 'none'}`}>
  <div class="preparation-artwork" aria-hidden="true"></div>
  <div class="preparation-veil" aria-hidden="true"></div>
  <div class="preparation-panel relative w-full max-w-lg">
    <div class="preparation-heading">
      <span class="playback-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.25 5.6v12.8L18 12 8.25 5.6Z" /></svg></span>
      <p class="preparation-kicker">{error ? 'Playback unavailable' : 'Preparing playback'}</p>
    </div>
    <h2 class="preparation-title">{title}</h2>
    {#if message}<p class="preparation-message" aria-live="polite">{message}</p>{/if}
    {#if !error}
      {#if indeterminate}
        <div class="preparation-progress" role="progressbar" aria-label="Preparing the video stream"><div class="preparation-progress-indeterminate"></div></div>
        <p class="preparation-detail">Still working — this final stage can take a little longer.</p>
      {:else}
        <div class="preparation-progress" role="progressbar" aria-label="Preparing playback" aria-valuenow={Math.round(progress || 0)} aria-valuemin="0" aria-valuemax="100"><div class="preparation-progress-fill" style={`width: ${Math.min(100, Math.max(3, progress || 0))}%`}></div></div>
        {#if detailed}<p class="preparation-detail tabular-nums">{Math.round(progress || 0)}% complete</p>{/if}
      {/if}
      {#if detailed && download}<p class="preparation-detail">{formatBytes(download.bytes)} downloaded · {formatBytes(download.bytesPerSecond)}/s{download.remainingSeconds ? ` · about ${download.remainingSeconds}s remaining` : ''}</p>{/if}
    {/if}
  </div>
</div>

<style>
  .playback-preparation { isolation: isolate; container-type: size; padding: clamp(1rem, 4vw, 3rem); background: #050607; }
  .preparation-artwork, .preparation-veil { position: absolute; inset: 0; }
  .preparation-artwork { background-image: var(--preparation-artwork); background-position: center 24%; background-size: cover; filter: saturate(.55) contrast(1.06); transform: scale(1.015); }
  .preparation-veil { background: linear-gradient(to top, rgb(2 3 4 / 94%) 0%, rgb(2 3 4 / 58%) 48%, rgb(2 3 4 / 42%) 100%); backdrop-filter: blur(2px); }
  .preparation-panel { padding: clamp(1.35rem, 3vw, 2rem); border: 1px solid rgb(255 255 255 / 20%); background: rgb(8 9 10 / 84%); color: white; box-shadow: 0 30px 80px rgb(0 0 0 / 44%); backdrop-filter: blur(18px); animation: preparation-panel-in 480ms cubic-bezier(.22, 1, .36, 1) both; }
  .preparation-panel::before { position: absolute; top: -1px; left: -1px; width: 4rem; height: 2px; background: var(--color-primary); content: ''; }
  .playback-preparation-error .preparation-panel::before { background: var(--color-warning); }
  .preparation-heading { display: flex; align-items: center; gap: .65rem; }
  .playback-mark { display: grid; width: 2.35rem; height: 2.35rem; flex: none; place-items: center; border: 1px solid rgb(255 255 255 / 20%); color: rgb(255 255 255 / 78%); animation: preparation-pulse 2.2s ease-in-out infinite; }
  .playback-mark svg { width: .9rem; height: .9rem; }
  .preparation-kicker { color: rgb(255 255 255 / 45%); font-size: .58rem; font-weight: 650; letter-spacing: .2em; text-transform: uppercase; }
  .preparation-title { margin-top: .9rem; font-family: var(--font-display); font-size: clamp(1.7rem, 4vw, 2.65rem); font-weight: 400; letter-spacing: -.035em; line-height: 1.05; }
  .preparation-message { margin-top: .7rem; color: rgb(255 255 255 / 55%); font-size: .78rem; line-height: 1.55; }
  .preparation-progress { width: 100%; height: 2px; margin-top: 1.35rem; overflow: hidden; background: rgb(255 255 255 / 13%); }
  .preparation-progress-fill, .preparation-progress-indeterminate { height: 100%; background: var(--color-primary); transition: width 500ms ease; }
  .preparation-progress-indeterminate { width: 34%; animation: preparation-slide 1.4s ease-in-out infinite; }
  .preparation-detail { margin-top: .65rem; color: rgb(255 255 255 / 42%); font-size: .63rem; letter-spacing: .02em; }
  .playback-preparation-error .playback-mark { animation: none; opacity: .55; }
  @keyframes preparation-panel-in { from { opacity: 0; transform: translateY(1.5rem); } to { opacity: 1; transform: translateY(0); } }
  @keyframes preparation-pulse { 50% { opacity: .5; } }
  @keyframes preparation-slide { from { transform: translateX(-110%); } to { transform: translateX(310%); } }
  @media (prefers-reduced-motion: reduce) { .preparation-progress-indeterminate { animation: none; margin-inline: auto; } .playback-mark, .preparation-panel { animation: none; } }
  @container (max-height: 18rem) {
    .playback-preparation { padding: .75rem; }
    .preparation-panel { max-width: 26rem; padding: .85rem; }
    .playback-mark { width: 1.8rem; height: 1.8rem; }
    .preparation-kicker { font-size: .48rem; }
    .preparation-title { margin-top: .45rem; font-size: clamp(1.15rem, 6vw, 1.5rem); }
    .preparation-message { margin-top: .3rem; font-size: .62rem; line-height: 1.3; }
    .preparation-progress { margin-top: .65rem; }
    .preparation-detail { margin-top: .35rem; font-size: .52rem; }
  }
</style>
