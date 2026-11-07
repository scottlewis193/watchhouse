<script>
  import { onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import { api } from '$lib/api';
  import MediaCard from '$lib/MediaCard.svelte';
  import { prewarmPlayback } from '$lib/poster-preparation.js';

  let query = $state('');
  let results = $state([]);
  let shelves = $state([]);
  let searchMessage = $state('');
  let loading = $state(false);
  let error = $state('');
  let catalogueLoading = $state(true);
  let catalogueError = $state('');
  let hasSearched = $state(false);
  let shelfPositions = $state({});
  let shelfLoading = $state({});
  let shelfErrors = $state({});
  const loadingShelfIds = new Set();
  let discoveryRequest;
  let library = $state([]);
  let continueWatching = $state([]);
  const prewarmedResumeKeys = new Set();
  let visibleShelves = $derived(continueWatching.length ? [{ id: 'continue-watching', title: 'Continue watching', items: continueWatching }, ...shelves] : shelves);

  onMount(() => { void loadState(); });

  $effect(() => {
    const requestedQuery = page.url.searchParams.get('q')?.trim() || '';
    if (requestedQuery) { query = requestedQuery; void search(); }
    else {
      query = '';
      hasSearched = false;
      results = [];
      error = '';
      searchMessage = '';
      void loadDiscovery();
    }
  });

  async function loadState() {
    try {
      let state = await api.get('/api/state');
      library = state.library; continueWatching = state.continueWatching;
      prewarmResumes();
      for (const item of continueWatching.filter(entry => entry.type === 'movie' && !entry.duration)) {
        const duration = (await api.get(`/api/catalog/movies/${item.id}/runtime`)).duration;
        if (!duration) continue;
        state = await api.put('/api/state/progress', { media: { ...item, durationHint: duration }, position: item.position, duration, watched: false });
        library = state.library; continueWatching = state.continueWatching;
      }
      const missing = [...new Map([...library, ...continueWatching].filter(item => !item.poster).map(item => [`${item.type}:${item.id}`, item])).values()];
      if (missing.length) {
        const details = await Promise.allSettled(missing.map(async item => {
          const kind = item.type === 'movie' ? 'movies' : 'shows';
          return (await api.get(`/api/catalog/${kind}/${item.id}/details`)).details;
        }));
        const repaired = details.flatMap(result => result.status === 'fulfilled' && result.value?.poster ? [result.value] : []);
        if (repaired.length) {
          state = await api.put('/api/state/media', { media: repaired });
          library = state.library; continueWatching = state.continueWatching;
        }
      }
    } catch {}
  }

  function prewarmResumes() {
    if (!navigator.onLine || navigator.connection?.saveData) return;
    for (const item of continueWatching.slice(0, 4)) {
      const key = `${item.type}:${item.id}:${item.season || ''}:${item.episode || ''}`;
      if (prewarmedResumeKeys.has(key)) continue;
      prewarmedResumeKeys.add(key);
      void prewarmPlayback(item).catch(() => prewarmedResumeKeys.delete(key));
    }
  }

  async function loadDiscovery() {
    if (discoveryRequest) return discoveryRequest;
    catalogueLoading = true; catalogueError = '';
    discoveryRequest = (async () => {
      try {
        shelves = (await api.get('/api/catalog/discover')).shelves.map(shelf => ({ ...shelf, items: uniqueItems(shelf.items) }));
        shelfPositions = {}; shelfErrors = {};
      } catch (e) { catalogueError = e.message; }
      finally { catalogueLoading = false; discoveryRequest = undefined; }
    })();
    return discoveryRequest;
  }

  function uniqueItems(items) {
    return [...new Map(items.map(item => [`${item.type}:${item.id}`, item])).values()];
  }

  async function loadMoreShelf(id, retry = false) {
    const shelf = shelves.find(shelf => shelf.id === id);
    if (!shelf?.hasMore || !shelf.nextPage || loadingShelfIds.has(id) || (shelfErrors[id] && !retry)) return;
    loadingShelfIds.add(id);
    shelfLoading[id] = true; shelfErrors[id] = '';
    try {
      const next = (await api.get(`/api/catalog/discover/${encodeURIComponent(id)}?page=${shelf.nextPage}`)).shelf;
      shelves = shelves.map(current => current.id === id ? { ...next, items: uniqueItems([...current.items, ...next.items]) } : current);
    } catch (e) { shelfErrors[id] = e.message; }
    finally {
      loadingShelfIds.delete(id); shelfLoading[id] = false;
    }
    await tick();
    const element = document.getElementById(`shelf-row-${id}`);
    if (element) updateShelfPosition(id, element);
  }

  async function search() {
    if (!query.trim()) { hasSearched = false; results = []; error = ''; return; }
    hasSearched = true;
    loading = true; error = ''; results = []; searchMessage = 'Searching catalogue…';
    try {
      results = (await api.get(`/api/catalog/search?q=${encodeURIComponent(query.trim())}`)).results;
      searchMessage = `${results.length} result${results.length === 1 ? '' : 's'}`;
    } catch (e) { error = e.message; searchMessage = 'Search unavailable'; }
    finally { loading = false; }
  }

  function watchHref(result) {
    const query = new URLSearchParams({ title: result.title, ...(result.year ? { year: result.year } : {}), ...(result.poster ? { poster: result.poster } : {}), ...(result.backdrop ? { backdrop: result.backdrop } : {}), ...(result.season ? { season: result.season, episode: result.episode } : {}) });
    return `/watch/${result.type}/${result.id}?${query}`;
  }

  function inLibrary(item) { return library.some(entry => entry.id === item.id && entry.type === item.type); }
  async function setLibrary(item, next) {
    const state = await api.put('/api/state/library', { media: item, inLibrary: next });
    library = state.library; continueWatching = state.continueWatching;
  }

  async function setWatched(item) {
    const state = await api.put('/api/state/progress', { media: item, watched: true });
    library = state.library; continueWatching = state.continueWatching;
  }

  async function clearProgress(item) {
    const state = await api.put('/api/state/progress', { media: item, watched: false, reset: true });
    library = state.library; continueWatching = state.continueWatching;
  }

  function updateShelfPosition(id, element) {
    const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
    const remaining = maximum - element.scrollLeft;
    shelfPositions[id] = { atStart: element.scrollLeft <= 2, atEnd: remaining <= 2 };
    if (remaining <= element.clientWidth) void loadMoreShelf(id);
  }

  function trackShelf(element, id) {
    const observer = new ResizeObserver(() => updateShelfPosition(id, element));
    observer.observe(element);
    updateShelfPosition(id, element);
    return { destroy() { observer.disconnect(); } };
  }

  async function scrollShelf(id, direction) {
    const element = document.getElementById(`shelf-row-${id}`);
    const card = element?.querySelector(':scope > article');
    if (!element || !card) return;
    if (direction > 0 && shelfPositions[id]?.atEnd) await loadMoreShelf(id, true);
    const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
    element.scrollBy({ left: direction * (card.getBoundingClientRect().width + gap) * 6, behavior: 'smooth' });
  }
</script>

<svelte:head><title>Discover · Watchhouse</title></svelte:head>

{#if hasSearched}
<section class="discover-page" aria-labelledby="discover-title">
  <div class="page-tools"><p id="discover-title"><span class="page-eyebrow">Search</span><span class="ml-3 text-sm text-base-content/75">“{query}” · {searchMessage}</span></p><a class="btn btn-sm btn-ghost" href="/">Clear search</a></div>
  {#if error}<div class="alert alert-error mb-4"><span>{error}</span><a class="btn btn-sm" href="/settings">Open settings</a></div>{/if}
  {#if results.length}
    <div class="poster-grid mt-9">
      {#each results as result}
        <MediaCard item={result} href={watchHref(result)} inLibrary={inLibrary(result)} onLibraryChange={setLibrary} />
      {/each}
    </div>
  {:else if !loading && !error}<div class="empty-state border-y border-base-300 py-16 text-center"><p class="empty-state-title">No matching titles</p><p class="mt-2 text-sm text-base-content/45">Try another film, series, or person.</p></div>{/if}
</section>
{:else}
  <section aria-label="Browse films and series" class="discover-page space-y-12">
    {#if catalogueError}<div class="alert alert-error"><span>{catalogueError}</span><div class="flex gap-2"><button class="btn btn-sm" onclick={loadDiscovery}>Try again</button><a class="btn btn-sm" href="/settings">Open settings</a></div></div>{/if}
    {#if catalogueLoading}
      {#each Array(3) as _}
        <div class="catalogue-skeleton"><div class="mb-4 h-6 w-40 animate-pulse bg-base-300"></div><div class="grid auto-cols-[8.75rem] grid-flow-col gap-4 overflow-hidden sm:auto-cols-[10.5rem]">{#each Array(6) as _}<div><div class="aspect-[2/3] animate-pulse bg-base-300"></div><div class="mt-3 h-4 w-3/4 animate-pulse bg-base-300"></div></div>{/each}</div></div>
      {/each}
    {:else}
      {#each visibleShelves as shelf (shelf.id)}
        <section class="media-shelf" aria-labelledby={`shelf-${shelf.id}`}>
          <div class="shelf-heading"><h2 id={`shelf-${shelf.id}`}>{shelf.title}</h2><span>{shelf.items.length} titles</span></div>
          <div class="group/shelf relative">
            <button
              class="absolute inset-y-0 left-0 z-10 hidden w-11 place-items-center bg-gradient-to-r from-base-200 via-base-200/90 to-transparent text-base-content transition hover:text-primary disabled:pointer-events-none disabled:opacity-0 md:grid"
              aria-label={`Previous ${shelf.title}`}
              data-spatial-ignore
              disabled={shelfPositions[shelf.id]?.atStart ?? true}
              onclick={() => scrollShelf(shelf.id, -1)}
            ><span class="grid size-9 place-items-center rounded-full border border-base-content/30 bg-base-200/90 text-2xl shadow-xl">‹</span></button>
            <div
              id={`shelf-row-${shelf.id}`}
              use:trackShelf={shelf.id}
              aria-busy={shelfLoading[shelf.id] || false}
              class="shelf-scroll grid snap-x snap-mandatory auto-cols-[8.75rem] grid-flow-col gap-4 overflow-x-auto pb-3 sm:auto-cols-[10.5rem] sm:gap-5 md:auto-cols-[calc((100%_-_6.25rem)/6)] md:snap-none"
              onscroll={(event) => updateShelfPosition(shelf.id, event.currentTarget)}
            >
              {#each shelf.items as item (`${item.type}:${item.id}:${item.season || ''}:${item.episode || ''}`)}<MediaCard item={item} prepareAhead={shelf.id === 'continue-watching'} href={watchHref(item)} inLibrary={inLibrary(item)} onLibraryChange={setLibrary} onWatched={shelf.id === 'continue-watching' ? setWatched : undefined} onClearProgress={shelf.id === 'continue-watching' ? clearProgress : undefined} />{/each}
            </div>
            <button
              class="absolute inset-y-0 right-0 z-10 hidden w-11 place-items-center bg-gradient-to-l from-base-200 via-base-200/90 to-transparent text-base-content transition hover:text-primary disabled:pointer-events-none disabled:opacity-0 md:grid"
              aria-label={`Next ${shelf.title}`}
              data-spatial-ignore
              disabled={(shelfPositions[shelf.id]?.atEnd ?? false) && !shelf.hasMore}
              onclick={() => scrollShelf(shelf.id, 1)}
            ><span class="grid size-9 place-items-center rounded-full border border-base-content/30 bg-base-200/90 text-2xl shadow-xl">›</span></button>
          </div>
          {#if shelfLoading[shelf.id]}
            <p class="mt-2 text-sm text-base-content/60" role="status">Loading more titles…</p>
          {:else if shelfErrors[shelf.id]}
            <div class="mt-2 flex items-center gap-3 text-sm" role="alert"><span>{shelfErrors[shelf.id]}</span><button class="btn btn-sm" onclick={() => loadMoreShelf(shelf.id, true)}>Try again</button></div>
          {/if}
        </section>
      {/each}
    {/if}
  </section>
{/if}
