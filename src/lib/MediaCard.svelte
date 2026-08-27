<script>
  let { item, href, inLibrary = false, onLibraryChange, onWatched, downloaded = false, disabled = false } = $props();
  const label = $derived(item.episodeTitle ? `${item.title}, season ${item.season}, episode ${item.episode}: ${item.episodeTitle}` : `${item.title}${item.year ? `, ${item.year}` : ''}`);
  const playHref = $derived(`${href}${href.includes('?') ? '&' : '?'}play=1${item.position ? '&resume=1' : ''}`);
</script>

<article class="media-card group relative min-w-0 snap-start" class:opacity-35={disabled} class:grayscale={disabled} title={disabled ? `${label} is not downloaded` : label}>
  <div class="relative">
    <a class="media-card-link block focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary" href={disabled ? undefined : href} aria-label={disabled ? `${label} is unavailable offline` : `View details for ${label}`} aria-disabled={disabled} onclick={(event) => { if (disabled) event.preventDefault(); }}>
    <figure class="media-card-poster relative aspect-[2/3] overflow-hidden bg-base-300">
      <span class="grid h-full place-items-center px-3 text-center text-[10px] tracking-[0.18em] text-base-content/35">{item.title}</span>
      {#if item.poster}<img class="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.025]" src={item.poster} alt="" loading="lazy" onerror={(event) => { event.currentTarget.hidden = true; }} />{/if}
      <span class="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-black/5 opacity-0 transition duration-500 group-hover:opacity-100 group-focus-within:opacity-100"></span>
      {#if item.progressPercent > 0}<span class="absolute inset-x-0 bottom-0 h-1 bg-black/70" role="progressbar" aria-label={item.progressPercent < 1 ? 'Less than 1% watched' : `${Math.round(item.progressPercent)}% watched`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Number(item.progressPercent.toFixed(1))}><span class="block h-full bg-primary" style={`width: max(2px, ${item.progressPercent}%)`}></span></span>{/if}
      {#if downloaded}<span class="absolute bottom-2 left-2 border border-white/25 bg-black/75 px-2 py-1 text-[9px] font-semibold tracking-[0.15em] text-white">OFFLINE</span>{/if}
      {#if disabled}<span class="absolute inset-x-2 bottom-2 bg-black/80 px-2 py-1.5 text-center text-[10px] font-semibold tracking-wide text-white">NOT DOWNLOADED</span>{/if}
    </figure>
    </a>
    <a class="media-card-play absolute left-1/2 top-1/2 z-10 grid size-11 -translate-x-1/2 -translate-y-1/2 scale-90 place-items-center border border-white/45 bg-black/55 text-white opacity-0 backdrop-blur-md transition duration-300 hover:bg-white hover:text-black focus:scale-100 focus:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary group-hover:scale-100 group-hover:opacity-100 group-focus-within:scale-100 group-focus-within:opacity-100" href={disabled ? undefined : playHref} aria-label={`Play ${label}`} aria-disabled={disabled} onclick={(event) => { if (disabled) event.preventDefault(); }}>
      <svg class="size-5 translate-x-px" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M5 3.7a1 1 0 0 1 1.54-.84l9 6.3a1 1 0 0 1 0 1.68l-9 6.3A1 1 0 0 1 5 16.3z" /></svg>
    </a>
  </div>
  <a class="media-card-link block focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary" href={disabled ? undefined : href} aria-label={`View details for ${label}`} aria-disabled={disabled} onclick={(event) => { if (disabled) event.preventDefault(); }}>
    <span class="media-card-meta block">
      <span class="media-card-title block truncate">{item.episodeTitle || item.title}</span>
      <span class="media-card-detail block truncate">{item.episodeTitle ? `${item.title} · S${item.season} E${item.episode}` : item.year || (item.type === 'tv' ? 'Series' : 'Film')}</span>
    </span>
  </a>
  {#if onLibraryChange}
    <button
      class="media-card-action absolute right-2 top-2 grid size-8 place-items-center border border-white/25 bg-black/70 text-base text-white backdrop-blur-md transition hover:border-white/70 hover:bg-white hover:text-black focus:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary group-hover:opacity-100"
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
      class="media-card-action absolute left-2 top-2 grid size-8 place-items-center border border-white/25 bg-black/70 text-sm text-white opacity-0 backdrop-blur-md transition hover:border-white/70 hover:bg-white hover:text-black focus:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary group-hover:opacity-100 group-focus-within:opacity-100"
      data-spatial-ignore
      aria-label={`Mark ${label} watched`}
      title="Mark watched"
      onclick={() => onWatched(item)}
    >✓</button>
  {/if}
</article>
