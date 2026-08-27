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

<div class="playback-preparation relative grid size-full overflow-hidden border border-base-300 bg-base-100 p-6 sm:p-10">
  <div class="playback-glow pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-primary/8 blur-3xl"></div>
  <div class="relative m-auto w-full max-w-md text-center">
    <span class="playback-mark mx-auto grid size-11 place-items-center border border-primary/60 text-[11px] font-bold text-primary"><span class="brand-initials">WH</span></span>
    <p class="mt-5 text-[11px] font-semibold tracking-[0.2em] text-base-content/45">PREPARING PLAYBACK</p>
    <h2 class="mt-3 text-xl font-semibold tracking-tight sm:text-2xl">{title}</h2>
    {#if message}<p class="mt-2 text-sm text-base-content/60" aria-live="polite">{message}</p>{/if}
    {#if !error}
      {#if indeterminate}
        <div class="preparation-progress mx-auto mt-6 h-px w-full max-w-xs overflow-hidden bg-base-300" role="progressbar" aria-label="Preparing the video stream"><div class="preparation-progress-indeterminate h-full w-1/3 bg-primary"></div></div>
        <p class="mt-3 text-xs text-base-content/45">Still working — this final stage can take a little longer.</p>
      {:else}
        <div class="preparation-progress mx-auto mt-6 h-px w-full max-w-xs overflow-hidden bg-base-300" role="progressbar" aria-label="Preparing playback" aria-valuenow={Math.round(progress || 0)} aria-valuemin="0" aria-valuemax="100"><div class="preparation-progress-fill h-full bg-primary transition-[width] duration-500" style={`width: ${Math.min(100, Math.max(3, progress || 0))}%`}></div></div>
        {#if detailed}<p class="mt-3 text-xs tabular-nums text-base-content/45">{Math.round(progress || 0)}% complete</p>{/if}
      {/if}
      {#if detailed && download}<p class="mt-2 text-xs text-base-content/55">{formatBytes(download.bytes)} downloaded · {formatBytes(download.bytesPerSecond)}/s{download.remainingSeconds ? ` · about ${download.remainingSeconds}s remaining` : ''}</p>{/if}
    {/if}
  </div>
</div>

<style>
  .preparation-progress-indeterminate { animation: preparation-slide 1.4s ease-in-out infinite; }
  @keyframes preparation-slide {
    from { transform: translateX(-110%); }
    to { transform: translateX(310%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .preparation-progress-indeterminate { animation: none; margin-inline: auto; }
  }
</style>
