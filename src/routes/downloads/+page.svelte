<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  import { offlineEpisodeState, offlineMediaKey } from '$lib/offline.js';

  let downloads = $state([]), jobs = $state([]), loading = $state(true), error = $state(''), actionError = $state(''), offline = $state(false);
  let busy = $state(new Set()), pollTimer;
  let groups = $derived(groupOfflineItems(downloads, jobs));
  let activeCount = $derived(jobs.filter(job => !['ready', 'error'].includes(job.status)).length);

  onMount(() => {
    offline = !navigator.onLine;
    const updateConnectivity = () => { offline = !navigator.onLine; };
    window.addEventListener('online', updateConnectivity); window.addEventListener('offline', updateConnectivity);
    void load();
    return () => { clearTimeout(pollTimer); window.removeEventListener('online', updateConnectivity); window.removeEventListener('offline', updateConnectivity); };
  });

  function groupOfflineItems(records, queued) {
    const grouped = new Map();
    const ensure = media => {
      if (!media?.type || !media?.id) return null;
      const key = `${media.type}:${media.id}`;
      if (!grouped.has(key)) grouped.set(key, { key, media, downloads: [], jobs: [] });
      const group = grouped.get(key);
      if ((media.poster && !group.media.poster) || (media.title && !group.media.title)) group.media = { ...group.media, ...media };
      return group;
    };
    for (const record of records) ensure(record.media)?.downloads.push(record);
    for (const job of queued) ensure(job.media)?.jobs.push(job);
    return [...grouped.values()].sort((a, b) => String(a.media.title).localeCompare(String(b.media.title)));
  }

  function remember() { localStorage.setItem('watchhouse-offline-downloads', JSON.stringify({ downloads, jobs })); }
  async function load() {
    try { const state = await api.get('/api/offline'); downloads = state.downloads; jobs = state.jobs; remember(); schedulePoll(); }
    catch (failure) {
      let cached; try { cached = JSON.parse(localStorage.getItem('watchhouse-offline-downloads') || 'null'); } catch {}
      if (offline && cached) { downloads = cached.downloads || []; jobs = cached.jobs || []; }
      else error = failure.message;
    } finally { loading = false; }
  }
  function schedulePoll() { clearTimeout(pollTimer); if (jobs.some(job => !['ready', 'error'].includes(job.status))) pollTimer = setTimeout(() => void refresh(), 1000); }
  async function refresh() { try { const state = await api.get('/api/offline'); downloads = state.downloads; jobs = state.jobs; remember(); } catch {} schedulePoll(); }
  function latestJobs(group) {
    const latest = new Map();
    for (const job of [...group.jobs].sort((a, b) => a.created - b.created)) latest.set(job.key, job);
    return [...latest.values()];
  }
  function batchJobs(group) { return latestJobs(group).filter(job => job.media.type === 'tv' && !Number.isInteger(Number(job.media.episode))); }
  function episodeRows(group) {
    const mediaByKey = new Map();
    for (const record of group.downloads) if (record.media.type === 'tv' && Number.isInteger(Number(record.media.episode))) mediaByKey.set(offlineMediaKey(record.media), record.media);
    for (const job of latestJobs(group)) if (job.media.type === 'tv' && Number.isInteger(Number(job.media.episode))) mediaByKey.set(offlineMediaKey(job.media), job.media);
    return [...mediaByKey.values()].map(media => ({ media, ...offlineEpisodeState(media, group.downloads, latestJobs(group)) })).sort((a, b) => a.media.season - b.media.season || a.media.episode - b.media.episode);
  }
  function movieState(group) { return offlineEpisodeState(group.media, group.downloads, latestJobs(group)); }
  function isActive(status) { return !['ready', 'error', 'available'].includes(status); }
  function episodeLabel(media) { return `S${String(media.season).padStart(2, '0')}E${String(media.episode).padStart(2, '0')}`; }
  function formatBytes(bytes) { const value = Number(bytes) || 0; if (!value) return ''; const units = ['B', 'KB', 'MB', 'GB']; const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024))); return `${(value / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`; }
  function watchHref(media) { const query = new URLSearchParams({ title: media.title || '', ...(media.year ? { year: media.year } : {}), ...(media.poster ? { poster: media.poster } : {}), ...(media.season ? { season: String(media.season) } : {}), ...(media.episode ? { episode: String(media.episode) } : {}) }); return `/watch/${media.type}/${media.id}?${query}`; }
  function setBusy(key, value) { const next = new Set(busy); if (value) next.add(key); else next.delete(key); busy = next; }
  async function retry(media) { const key = offlineMediaKey(media); actionError = ''; setBusy(key, true); try { await api.post('/api/offline', media); await refresh(); } catch (failure) { actionError = failure.message; } finally { setBusy(key, false); } }
  async function cancelDownload(job) { actionError = ''; setBusy(job.id, true); try { await api.delete(`/api/offline/job/${job.id}`); jobs = jobs.map(item => item.id === job.id ? { ...item, status: 'cancelling', message: 'Cancelling download…' } : item); remember(); await refresh(); } catch (failure) { actionError = failure.message; } finally { setBusy(job.id, false); } }
  async function removeItem(key) { actionError = ''; setBusy(key, true); try { await api.delete(`/api/offline/item/${encodeURIComponent(key)}`); await refresh(); } catch (failure) { actionError = failure.message; } finally { setBusy(key, false); } }
  async function removeTitle(media) { const key = `${media.type}:${media.id}`; actionError = ''; setBusy(key, true); try { await api.delete(`/api/offline/${media.type}/${media.id}`); await refresh(); } catch (failure) { actionError = failure.message; } finally { setBusy(key, false); } }
</script>

<svelte:head><title>Downloads · Watchhouse</title></svelte:head>

<section class="downloads-page">
  <div class="page-tools"><span class="page-eyebrow">{downloads.length} saved{activeCount ? ` · ${activeCount} active` : ''}</span><a class="btn btn-sm btn-ghost" href="/library">Open library</a></div>
  {#if offline}<div class="alert alert-warning"><span>You’re offline. Saved episodes remain playable, but download controls are paused.</span></div>{/if}
  {#if error}<div class="alert alert-error"><span>{error}</span></div>{/if}
  {#if actionError}<div class="alert alert-error"><span>{actionError}</span><button class="btn btn-sm btn-ghost" onclick={() => { actionError = ''; }}>Dismiss</button></div>{/if}

  {#if loading}<div class="editorial-loading grid place-items-center py-24"><span class="loading loading-spinner loading-lg"></span><p>Opening download manager</p></div>
  {:else if !groups.length}<div class="empty-state border-b border-base-300 py-24 text-center"><p class="empty-state-title">Nothing downloaded yet</p><p class="mx-auto mt-3 max-w-md text-sm text-base-content/45">Open a film or series to save it. Episodes and entire seasons can be added independently.</p><a class="btn btn-primary btn-sm mt-6" href="/library">Browse your library</a></div>
  {:else}<div class="divide-y divide-base-300 border-b border-base-300">
    {#each groups as group}
      <article class="download-group grid gap-6 py-8 md:grid-cols-[6rem_minmax(0,1fr)]">
        <a href={watchHref(group.media)} class="block self-start"><div class="aspect-[2/3] overflow-hidden bg-base-300">{#if group.media.poster}<img class="h-full w-full object-cover" src={group.media.poster} alt="" />{:else}<div class="grid h-full place-items-center text-2xl text-base-content/25">▶</div>{/if}</div></a>
        <div class="min-w-0">
          <div class="flex flex-wrap items-start justify-between gap-4"><div><p class="page-eyebrow">{group.media.type === 'tv' ? 'Series' : 'Film'}{group.media.year ? ` · ${group.media.year}` : ''}</p><h2 class="download-title mt-2"><a class="hover:text-primary" href={watchHref(group.media)}>{group.media.title}</a></h2><p class="mt-2 text-xs text-base-content/45">{group.downloads.length} {group.downloads.length === 1 ? 'item' : 'items'} ready offline</p></div>{#if group.downloads.length}<button class="btn btn-sm btn-ghost" disabled={offline || busy.has(`${group.media.type}:${group.media.id}`)} onclick={() => void removeTitle(group.media)}>Remove all</button>{/if}</div>

          {#each batchJobs(group) as job}<div class="mt-5 border-y border-base-300 py-4"><div class="flex items-center justify-between gap-4"><div class="min-w-0"><p class="text-sm font-medium">{job.media.season ? `Season ${job.media.season}` : 'Entire series'}</p><p class="mt-1 truncate text-xs text-base-content/50">{job.message}</p></div>{#if job.status === 'error'}<button class="btn btn-sm btn-outline" disabled={offline || busy.has(job.key)} onclick={() => void retry(job.media)}>Retry</button>{:else}<div class="flex shrink-0 items-center gap-3"><span class="text-xs tabular-nums text-base-content/55">{job.completed || 0}/{job.total || '…'}</span>{#if isActive(job.status) && job.status !== 'cancelling'}<button class="btn btn-sm btn-ghost" disabled={offline || busy.has(job.id)} onclick={() => void cancelDownload(job)}>Cancel</button>{/if}</div>{/if}</div>{#if isActive(job.status)}<progress class="progress progress-primary mt-3 h-1.5 w-full" value={job.progress || 0} max="100"></progress>{/if}</div>{/each}

          {#if group.media.type === 'tv'}
            <div class="mt-5 divide-y divide-base-300 border-y border-base-300">{#each episodeRows(group) as row}<div class="flex items-center gap-4 py-3"><a class="min-w-0 flex-1" href={watchHref(row.media)}><span class="block text-xs font-semibold tracking-wider text-base-content/45">{episodeLabel(row.media)}</span><span class="mt-1 block truncate text-sm">{row.media.episodeTitle || `Episode ${row.media.episode}`}</span>{#if isActive(row.status)}<span class="mt-1 block truncate text-[11px] text-base-content/45">{row.item.message}</span>{/if}</a><span class="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-base-content/45">{row.status === 'ready' ? 'Ready' : isActive(row.status) ? row.status === 'cancelling' ? 'Stopping' : `${Math.round(row.item.progress || 0)}%` : 'Failed'}</span>{#if row.status === 'ready'}<button class="btn btn-xs btn-ghost" disabled={offline || busy.has(row.item.key)} onclick={() => void removeItem(row.item.key)}>Remove</button>{:else if row.status === 'error'}<button class="btn btn-xs btn-outline" disabled={offline || busy.has(offlineMediaKey(row.media))} onclick={() => void retry(row.media)}>Retry</button>{:else if row.status !== 'cancelling'}<button class="btn btn-xs btn-ghost" disabled={offline || busy.has(row.item.id)} onclick={() => void cancelDownload(row.item)}>Cancel</button>{/if}</div>{/each}</div>
          {:else}{@const state = movieState(group)}{#if isActive(state.status)}<div class="mt-5"><progress class="progress progress-primary h-1.5 w-full" value={state.item.progress || 0} max="100"></progress><div class="mt-2 flex items-center justify-between gap-4"><p class="text-xs text-base-content/50">{state.item.message}{state.item.download?.bytes ? ` · ${formatBytes(state.item.download.bytes)} downloaded` : ''}</p>{#if state.status !== 'cancelling'}<button class="btn btn-xs btn-ghost" disabled={offline || busy.has(state.item.id)} onclick={() => void cancelDownload(state.item)}>Cancel</button>{/if}</div></div>{:else if state.status === 'error'}<div class="mt-5 flex items-center justify-between gap-4 border-y border-base-300 py-4"><p class="text-xs text-error">{state.item.message}</p><button class="btn btn-sm btn-outline" disabled={offline || busy.has(offlineMediaKey(group.media))} onclick={() => void retry(group.media)}>Retry</button></div>{/if}{/if}
        </div>
      </article>
    {/each}
  </div>{/if}
</section>

<style>
  .download-title { font-family: var(--font-display); font-size: clamp(1.55rem, 3vw, 2.25rem); font-weight: 400; letter-spacing: -.035em; }
</style>
