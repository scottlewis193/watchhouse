<script>
  let { item, href, inLibrary = false, onLibraryChange, onWatched } = $props();
  const label = $derived(item.episodeTitle ? `${item.title}, season ${item.season}, episode ${item.episode}: ${item.episodeTitle}` : `${item.title}${item.year ? `, ${item.year}` : ''}`);
</script>

<article class="media-card group relative min-w-0 snap-start" title={label}>
  <a class="block overflow-hidden bg-base-300 shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" href={href} aria-label={label}>
    <figure class="relative aspect-[2/3] overflow-hidden">
      {#if item.poster}<img class="h-full w-full object-cover grayscale-[10%] transition duration-300 group-hover:scale-[1.04] group-hover:grayscale-0" src={item.poster} alt="" loading="lazy" />{:else}<span class="grid h-full place-items-center px-3 text-center text-[10px] tracking-[0.18em] text-base-content/35">{item.title}</span>{/if}
      <span class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100"></span>
      <span class="pointer-events-none absolute left-1/2 top-1/2 grid size-12 -translate-x-1/2 -translate-y-1/2 scale-75 place-items-center rounded-full border border-white/60 bg-black/70 text-white opacity-0 shadow-xl backdrop-blur-sm transition duration-200 group-hover:scale-100 group-hover:opacity-100 group-focus-within:scale-100 group-focus-within:opacity-100" aria-hidden="true">
        <svg class="size-5 translate-x-px" viewBox="0 0 20 20" fill="currentColor"><path d="M5 3.7a1 1 0 0 1 1.54-.84l9 6.3a1 1 0 0 1 0 1.68l-9 6.3A1 1 0 0 1 5 16.3z" /></svg>
      </span>
      {#if item.progressPercent > 0}<span class="absolute inset-x-0 bottom-0 h-1.5 bg-black/70" role="progressbar" aria-label={item.progressPercent < 1 ? 'Less than 1% watched' : `${Math.round(item.progressPercent)}% watched`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Number(item.progressPercent.toFixed(1))}><span class="block h-full bg-primary shadow-[0_0_8px_currentColor]" style={`width: max(2px, ${item.progressPercent}%)`}></span></span>{/if}
    </figure>
  </a>
  {#if onLibraryChange}
    <button
      class="absolute right-2 top-2 grid size-9 place-items-center rounded-full border border-white/40 bg-black/75 text-lg text-white shadow-lg transition hover:border-primary hover:bg-primary hover:text-primary-content focus:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary group-hover:opacity-100"
      class:opacity-0={!inLibrary}
      class:opacity-100={inLibrary}
      data-spatial-ignore
      aria-label={inLibrary ? `Remove ${item.title} from library` : `Add ${item.title} to library`}
      aria-pressed={inLibrary}
      onclick={() => onLibraryChange(item, !inLibrary)}
    >{inLibrary ? '✓' : '+'}</button>
  {/if}
  {#if onWatched}
    <button
      class="absolute left-2 top-2 grid size-9 place-items-center rounded-full border border-white/40 bg-black/75 text-sm text-white opacity-0 shadow-lg transition hover:border-primary hover:bg-primary hover:text-primary-content focus:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary group-hover:opacity-100 group-focus-within:opacity-100"
      data-spatial-ignore
      aria-label={`Mark ${label} watched`}
      title="Mark watched"
      onclick={() => onWatched(item)}
    >✓</button>
  {/if}
</article>
