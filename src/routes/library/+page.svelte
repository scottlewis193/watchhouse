<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  import MediaCard from '$lib/MediaCard.svelte';

  let library = $state([]), loading = $state(true), error = $state('');
  let movies = $derived(library.filter(item => item.type === 'movie'));
  let shows = $derived(library.filter(item => item.type === 'tv'));

  onMount(async () => { try { library = (await api.get('/api/state')).library; } catch (e) { error = e.message; } finally { loading = false; } });

  function watchHref(item) {
    const query = new URLSearchParams({ title: item.title, ...(item.year ? { year: item.year } : {}), ...(item.poster ? { poster: item.poster } : {}) });
    return `/watch/${item.type}/${item.id}?${query}`;
  }

  async function setLibrary(item, inLibrary) { library = (await api.put('/api/state/library', { media: item, inLibrary })).library; }
</script>

<svelte:head><title>Library · Watchhouse</title></svelte:head>

<section class="pt-2">
  <div class="border-b border-base-300 pb-4"><p class="text-xs font-semibold tracking-[0.18em] text-base-content/50">YOUR COLLECTION</p><h1 class="mt-2 text-3xl font-semibold tracking-tight">Library</h1></div>
  {#if error}<div class="alert alert-error mt-6"><span>{error}</span></div>{/if}
  {#if loading}<div class="grid place-items-center py-20"><span class="loading loading-spinner loading-lg"></span></div>
  {:else if !library.length}<div class="border-b border-base-300 py-20 text-center"><p class="text-base-content/60">Your library is empty.</p><a class="btn btn-primary btn-sm mt-4" href="/">Browse films and series</a></div>
  {:else}
    {#each [{ title: 'Movies', items: movies }, { title: 'Shows', items: shows }] as group}
      {#if group.items.length}<section class="mt-10" aria-labelledby={`library-${group.title.toLowerCase()}`}><h2 class="mb-4 border-b border-base-300 pb-3 text-xl font-semibold" id={`library-${group.title.toLowerCase()}`}>{group.title}</h2><div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">{#each group.items as item}<MediaCard {item} href={watchHref(item)} inLibrary={true} onLibraryChange={setLibrary} />{/each}</div></section>{/if}
    {/each}
  {/if}
</section>
