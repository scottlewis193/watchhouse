<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  import MediaCard from '$lib/MediaCard.svelte';
  import { offlineAvailability } from '$lib/offline.js';

  let library = $state([]), loading = $state(true), error = $state('');
  let downloads = $state([]), jobs = $state([]), offline = $state(false), actionError = $state('');
  let pollTimer;
  let movies = $derived(library.filter(item => item.type === 'movie'));
  let shows = $derived(library.filter(item => item.type === 'tv'));

  onMount(() => {
    offline = !navigator.onLine;
    const updateConnectivity = () => { offline = !navigator.onLine; };
    window.addEventListener('online', updateConnectivity); window.addEventListener('offline', updateConnectivity);
    void load();
    return () => { clearTimeout(pollTimer); window.removeEventListener('online', updateConnectivity); window.removeEventListener('offline', updateConnectivity); };
  });

  async function load() {
    try {
      const [state, offlineState] = await Promise.all([api.get('/api/state'), api.get('/api/offline')]);
      library = state.library; downloads = offlineState.downloads; jobs = offlineState.jobs;
      localStorage.setItem('watchhouse-offline-library', JSON.stringify({ library, downloads }));
      schedulePoll();
    } catch (e) {
      let cached = null; try { cached = JSON.parse(localStorage.getItem('watchhouse-offline-library') || 'null'); } catch {}
      if (offline && cached) { library = cached.library || []; downloads = cached.downloads || []; }
      else error = e.message;
    } finally { loading = false; }
  }

  function schedulePoll() { clearTimeout(pollTimer); if (jobs.some(job => !['ready', 'error'].includes(job.status))) pollTimer = setTimeout(() => void refreshDownloads(), 1000); }
  async function refreshDownloads() { try { const state = await api.get('/api/offline'); downloads = state.downloads; jobs = state.jobs; localStorage.setItem('watchhouse-offline-library', JSON.stringify({ library, downloads })); } catch {} schedulePoll(); }
  function availability(item) { return offlineAvailability(item, downloads); }
  function activeJob(item) { return jobs.find(job => job.media?.type === item.type && Number(job.media?.id) === Number(item.id) && !['ready', 'error'].includes(job.status)); }
  function failedJob(item) { return [...jobs].reverse().find(job => job.media?.type === item.type && Number(job.media?.id) === Number(item.id) && job.status === 'error'); }
  async function download(item) { actionError = ''; try { const job = await api.post('/api/offline', item); if (job?.id) jobs = [...jobs.filter(existing => existing.id !== job.id), job]; schedulePoll(); } catch (e) { actionError = e.message; } }
  async function removeDownload(item) { actionError = ''; try { await api.delete(`/api/offline/${item.type}/${item.id}`); await refreshDownloads(); } catch (e) { actionError = e.message; } }

  function watchHref(item) {
    const query = new URLSearchParams({ title: item.title, ...(item.year ? { year: item.year } : {}), ...(item.poster ? { poster: item.poster } : {}) });
    return `/watch/${item.type}/${item.id}?${query}`;
  }

  async function setLibrary(item, inLibrary) { library = (await api.put('/api/state/library', { media: item, inLibrary })).library; }
</script>

<svelte:head><title>Library · Watchhouse</title></svelte:head>

<section class="pt-2">
  <div class="border-b border-base-300 pb-4"><p class="text-xs font-semibold tracking-[0.18em] text-base-content/50">YOUR COLLECTION</p><h1 class="mt-2 text-3xl font-semibold tracking-tight">Library</h1></div>
  {#if offline}<div class="alert alert-warning mt-6"><span>You’re offline. Titles without a completed download are unavailable.</span></div>{/if}
  {#if error}<div class="alert alert-error mt-6"><span>{error}</span></div>{/if}
  {#if actionError}<div class="alert alert-error mt-6"><span>{actionError}</span><button class="btn btn-sm btn-ghost" onclick={() => { actionError = ''; }}>Dismiss</button></div>{/if}
  {#if loading}<div class="grid place-items-center py-20"><span class="loading loading-spinner loading-lg"></span></div>
  {:else if !library.length}<div class="border-b border-base-300 py-20 text-center"><p class="text-base-content/60">Your library is empty.</p><a class="btn btn-primary btn-sm mt-4" href="/">Browse films and series</a></div>
  {:else}
    {#each [{ title: 'Movies', items: movies }, { title: 'Shows', items: shows }] as group}
      {#if group.items.length}<section class="mt-10" aria-labelledby={`library-${group.title.toLowerCase()}`}><h2 class="mb-4 border-b border-base-300 pb-3 text-xl font-semibold" id={`library-${group.title.toLowerCase()}`}>{group.title}</h2><div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">{#each group.items as item}{@const available = availability(item)}{@const job = activeJob(item)}{@const failed = failedJob(item)}<div><MediaCard {item} href={watchHref(item)} inLibrary={true} onLibraryChange={setLibrary} downloaded={available.available} disabled={offline && !available.available} />{#if job}<div class="mt-2"><progress class="progress progress-primary h-1.5 w-full" value={job.progress || 0} max="100"></progress><p class="mt-1 truncate text-[10px] text-base-content/55">{job.message}</p></div>{:else if available.available}<button class="btn btn-ghost btn-xs mt-2 w-full" disabled={offline} onclick={() => void removeDownload(item)}>Remove download{item.type === 'tv' && available.count > 1 ? ` (${available.count})` : ''}</button>{:else}<button class="btn btn-outline btn-xs mt-2 w-full" disabled={offline} onclick={() => void download(item)}>Download {item.type === 'tv' ? 'series' : 'movie'}</button>{#if failed}<p class="mt-1 line-clamp-2 text-[10px] text-error" title={failed.message}>{failed.message}</p>{/if}{/if}</div>{/each}</div></section>{/if}
    {/each}
  {/if}
</section>
