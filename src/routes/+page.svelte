<script>
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { api } from '$lib/api';
  import MediaCard from '$lib/MediaCard.svelte';

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
  let library = $state([]);
  let continueWatching = $state([]);
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
      for (const item of continueWatching.filter(entry => entry.type === 'movie' && !entry.duration)) {
        const duration = (await api.get(`/api/catalog/movies/${item.id}/runtime`)).duration;
        if (!duration) continue;
        state = await api.put('/api/state/progress', { media: { ...item, durationHint: duration }, position: item.position, duration, watched: false });
        library = state.library; continueWatching = state.continueWatching;
      }
    } catch {}
  }

  async function loadDiscovery() {
    catalogueLoading = true; catalogueError = '';
    try { shelves = (await api.get('/api/catalog/discover')).shelves; }
    catch (e) { catalogueError = e.message; }
    finally { catalogueLoading = false; }
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
    const query = new URLSearchParams({ title: result.title, ...(result.year ? { year: result.year } : {}), ...(result.poster ? { poster: result.poster } : {}), ...(result.season ? { season: result.season, episode: result.episode } : {}) });
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

  function updateShelfPosition(id, element) {
    const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
    shelfPositions[id] = { atStart: element.scrollLeft <= 2, atEnd: element.scrollLeft >= maximum - 2 };
  }

  function scrollShelf(id, direction) {
    const element = document.getElementById(`shelf-row-${id}`);
    const card = element?.querySelector(':scope > article');
    if (!element || !card) return;
    const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
    element.scrollBy({ left: direction * (card.getBoundingClientRect().width + gap) * 6, behavior: 'smooth' });
  }
</script>

<svelte:head><title>Discover · Watchhouse</title></svelte:head>

{#if hasSearched}
<section class="discover-page" aria-labelledby="discover-title">
  <div class="page-heading"><div><p class="page-eyebrow">Catalogue search</p><h1 id="discover-title">Results for “{query}”</h1></div><div class="page-heading-meta"><span>{searchMessage}</span><a href="/">Back to browse</a></div></div>
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
    <div class="page-heading"><div><p class="page-eyebrow">Curated for your screen</p><h1>Discover</h1></div><p class="page-intro">Films and series, gathered in one quiet place.</p></div>
    {#if catalogueError}<div class="alert alert-error"><span>{catalogueError}</span><div class="flex gap-2"><button class="btn btn-sm" onclick={loadDiscovery}>Try again</button><a class="btn btn-sm" href="/settings">Open settings</a></div></div>{/if}
    {#if catalogueLoading}
      {#each Array(3) as _}
        <div class="catalogue-skeleton"><div class="mb-4 h-6 w-40 animate-pulse bg-base-300"></div><div class="grid auto-cols-[8.75rem] grid-flow-col gap-4 overflow-hidden sm:auto-cols-[10.5rem]">{#each Array(6) as _}<div><div class="aspect-[2/3] animate-pulse bg-base-300"></div><div class="mt-3 h-4 w-3/4 animate-pulse bg-base-300"></div></div>{/each}</div></div>
      {/each}
    {:else}
      {#each visibleShelves as shelf}
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
              class="shelf-scroll grid snap-x snap-mandatory auto-cols-[8.75rem] grid-flow-col gap-4 overflow-x-auto pb-3 sm:auto-cols-[10.5rem] sm:gap-5 md:auto-cols-[calc((100%_-_6.25rem)/6)] md:snap-none"
              onscroll={(event) => updateShelfPosition(shelf.id, event.currentTarget)}
            >
              {#each shelf.items as item}<MediaCard item={item} href={watchHref(item)} inLibrary={inLibrary(item)} onLibraryChange={setLibrary} onWatched={shelf.id === 'continue-watching' ? setWatched : undefined} />{/each}
            </div>
            <button
              class="absolute inset-y-0 right-0 z-10 hidden w-11 place-items-center bg-gradient-to-l from-base-200 via-base-200/90 to-transparent text-base-content transition hover:text-primary disabled:pointer-events-none disabled:opacity-0 md:grid"
              aria-label={`Next ${shelf.title}`}
              data-spatial-ignore
              disabled={shelfPositions[shelf.id]?.atEnd ?? false}
              onclick={() => scrollShelf(shelf.id, 1)}
            ><span class="grid size-9 place-items-center rounded-full border border-base-content/30 bg-base-200/90 text-2xl shadow-xl">›</span></button>
          </div>
        </section>
      {/each}
    {/if}
  </section>
{/if}
