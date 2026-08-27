<script>
  let { title, message = '', progress = 0, download = null, detailed = false, error = false, indeterminate = false } = $props();

  function formatBytes(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes, index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
  }
</script>

<div class="playback-preparation relative grid size-full overflow-hidden border border-base-300 p-6 sm:p-10" class:playback-preparation-error={error}>
  <div class="preparation-beam" aria-hidden="true"></div>
  <div class="relative m-auto w-full max-w-lg text-center">
    <svg class="playback-mark mx-auto" viewBox="0 0 80 80" aria-hidden="true">
      <circle class="playback-mark-orbit" cx="40" cy="40" r="34" fill="none" stroke="currentColor" stroke-width=".75" />
      <circle class="playback-mark-orbit playback-mark-orbit-inner" cx="40" cy="40" r="25" fill="none" stroke="currentColor" stroke-width=".75" />
      <path class="playback-mark-play" d="M34 29.5v21l17-10.5z" fill="currentColor" />
    </svg>
    <p class="preparation-kicker mt-6">{error ? 'Playback unavailable' : 'Preparing playback'}</p>
    <h2 class="preparation-title mt-3">{title}</h2>
    {#if message}<p class="mt-2 text-sm text-base-content/60" aria-live="polite">{message}</p>{/if}
    {#if !error}
      {#if indeterminate}
        <div class="preparation-progress mx-auto mt-6 h-px w-full max-w-xs overflow-hidden bg-base-300" role="progressbar" aria-label="Preparing the video stream"><div class="preparation-progress-indeterminate h-full w-1/3 bg-primary"></div></div>
        <p class="preparation-detail mt-3">Still working — this final stage can take a little longer.</p>
      {:else}
        <div class="preparation-progress mx-auto mt-6 h-px w-full max-w-xs overflow-hidden bg-base-300" role="progressbar" aria-label="Preparing playback" aria-valuenow={Math.round(progress || 0)} aria-valuemin="0" aria-valuemax="100"><div class="preparation-progress-fill h-full bg-primary transition-[width] duration-500" style={`width: ${Math.min(100, Math.max(3, progress || 0))}%`}></div></div>
        {#if detailed}<p class="preparation-detail mt-3 tabular-nums">{Math.round(progress || 0)}% complete</p>{/if}
      {/if}
      {#if detailed && download}<p class="preparation-detail mt-2">{formatBytes(download.bytes)} downloaded · {formatBytes(download.bytesPerSecond)}/s{download.remainingSeconds ? ` · about ${download.remainingSeconds}s remaining` : ''}</p>{/if}
    {/if}
  </div>
</div>

<style>
  .playback-preparation {
    isolation: isolate;
    container-type: size;
    background:
      radial-gradient(circle at 50% 46%, color-mix(in srgb, var(--color-primary) 7%, transparent), transparent 19rem),
      linear-gradient(145deg, #101112, #070809);
  }
  .playback-preparation::before {
    position: absolute;
    inset: 0;
    opacity: .08;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.75' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.45'/%3E%3C/svg%3E");
    content: '';
    pointer-events: none;
  }
  .preparation-beam { position: absolute; z-index: -1; width: 52rem; height: 1px; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--color-primary) 30%, transparent), transparent); transform: rotate(-24deg); animation: preparation-beam 3.4s ease-in-out infinite; }
  .playback-mark { width: 5.25rem; color: color-mix(in srgb, var(--color-base-content) 76%, transparent); filter: drop-shadow(0 0 20px color-mix(in srgb, var(--color-primary) 16%, transparent)); }
  .playback-mark-orbit { transform-origin: center; animation: preparation-orbit 8s linear infinite; stroke-dasharray: 22 8; }
  .playback-mark-orbit-inner { animation-direction: reverse; animation-duration: 5.5s; stroke-dasharray: 8 6; }
  .playback-mark-play { transform-origin: center; animation: preparation-pulse 2.4s ease-in-out infinite; }
  .preparation-kicker { color: color-mix(in srgb, var(--color-base-content) 42%, transparent); font-size: .62rem; font-weight: 600; letter-spacing: .24em; text-transform: uppercase; }
  .preparation-title { font-family: var(--font-display); font-size: clamp(1.65rem, 4vw, 2.8rem); font-weight: 400; letter-spacing: -.035em; line-height: 1.05; }
  .preparation-detail { color: color-mix(in srgb, var(--color-base-content) 42%, transparent); font-size: .68rem; letter-spacing: .03em; }
  .playback-preparation-error .playback-mark { animation: none; opacity: .55; }
  .preparation-progress-indeterminate { animation: preparation-slide 1.4s ease-in-out infinite; }
  @keyframes preparation-orbit { to { transform: rotate(360deg); } }
  @keyframes preparation-pulse { 50% { opacity: .55; transform: scale(.9); } }
  @keyframes preparation-beam { 0%, 100% { opacity: .15; transform: rotate(-24deg) scaleX(.5); } 50% { opacity: .7; transform: rotate(-24deg) scaleX(1); } }
  @keyframes preparation-slide {
    from { transform: translateX(-110%); }
    to { transform: translateX(310%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .preparation-progress-indeterminate { animation: none; margin-inline: auto; }
    .playback-mark-orbit, .playback-mark-play, .preparation-beam { animation: none; }
  }
  @container (max-height: 18rem) {
    .playback-preparation { padding: .65rem; }
    .playback-mark { width: 3rem; }
    .preparation-kicker { margin-top: .35rem; font-size: .48rem; }
    .preparation-title { margin-top: .2rem; font-size: clamp(1.1rem, 6vw, 1.45rem); }
    .preparation-title + p { margin-top: .2rem; font-size: .62rem; line-height: 1.25; }
    .preparation-progress { margin-top: .55rem; }
    .preparation-detail { margin-top: .3rem; font-size: .52rem; }
  }
</style>
