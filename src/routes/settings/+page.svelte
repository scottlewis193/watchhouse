<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api';

  let form = $state({ tmdbToken: '', indexerUrl: '', indexerKey: '', usenetHost: '', usenetPort: '563', usenetUser: '', usenetPass: '', manualReleaseSelection: false, detailedPlaybackProgress: false, playbackDiagnostics: false, playbackQuality: 'balanced', untaggedAudioTrack: '2', maxConnections: '4', cacheRetentionHours: '24' });
  let loading = $state(true);
  let saving = $state(false);
  let notice = $state('');
  let noticeType = $state('success');
  let configured = $state(false);
  let theme = $state('watchhouse');
  const themes = [
    { id: 'watchhouse', name: 'Watchhouse', description: 'Gallery black and ivory', colours: ['#08090a', '#262729', '#ded8cd'] },
    { id: 'midnight', name: 'Midnight', description: 'Deep navy and cyan', colours: ['#0d1722', '#283b4d', '#73c9d8'] },
    { id: 'cinema', name: 'Cinema', description: 'Near-black and red', colours: ['#140f10', '#3e2d2f', '#dc6b61'] },
    { id: 'paper', name: 'Paper', description: 'Warm light and teal', colours: ['#f3efe6', '#d8d0c1', '#326b71'] }
  ];

  onMount(async () => {
    theme = themes.some(option => option.id === document.documentElement.dataset.theme) ? document.documentElement.dataset.theme : 'watchhouse';
    try { const config = await api.get('/api/settings'); form = { ...form, ...Object.fromEntries(Object.entries(config).filter(([key]) => key in form)) }; configured = Boolean(config.indexerUrl && config.usenetHost && config.hasTmdbToken); }
    catch (e) { show(e.message, 'error'); }
    finally { loading = false; }
  });
  function show(message, type = 'success') { notice = message; noticeType = type; }
  async function save() { saving = true; try { const config = await api.put('/api/settings', form); configured = Boolean(config.indexerUrl && config.usenetHost && config.hasTmdbToken); form.indexerKey = ''; form.usenetPass = ''; form.tmdbToken = ''; show('Settings saved. Credentials remain on this local server.'); } catch (e) { show(e.message, 'error'); } finally { saving = false; } }
  async function testConnection() { try { show('Testing Usenet connection…'); show((await api.post('/api/usenet/test', form)).message); } catch (e) { show(e.message, 'error'); } }
  async function clear() { try { await api.delete('/api/settings'); form = { tmdbToken: '', indexerUrl: '', indexerKey: '', usenetHost: '', usenetPort: '563', usenetUser: '', usenetPass: '', manualReleaseSelection: false, detailedPlaybackProgress: false, playbackDiagnostics: false, playbackQuality: 'balanced', untaggedAudioTrack: '2', maxConnections: '4', cacheRetentionHours: '24' }; configured = false; show('Settings cleared.'); } catch (e) { show(e.message, 'error'); } }
  function selectTheme(nextTheme) {
    theme = nextTheme;
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem('watchhouse-theme', nextTheme);
  }
</script>

<svelte:head><title>Settings · Watchhouse</title></svelte:head>

<div class="settings-page mx-auto max-w-5xl">
  <div class="page-heading"><div><p class="page-eyebrow">Private configuration</p><h1>Settings</h1><p class="page-intro mt-4">Personalise Watchhouse and configure catalogue search, indexer access, and playback.</p></div><span class="text-xs font-semibold tracking-wide {configured ? 'text-success' : 'text-warning'}">{configured ? 'CONFIGURED' : 'SETUP REQUIRED'}</span></div>
  {#if notice}<div class="alert alert-{noticeType} mb-6"><span>{notice}</span></div>{/if}
  {#if loading}
    <div class="editorial-loading grid place-items-center p-20"><span class="loading loading-spinner loading-lg"></span><p>Loading private settings</p></div>
  {:else}
    <form class="settings-form space-y-8" onsubmit={(event) => { event.preventDefault(); save(); }}>
      <section class="card border border-base-300 bg-base-100 shadow-sm">
        <div class="card-body gap-0 p-5 sm:p-7">
          <h2 class="card-title">Appearance</h2>
          <p class="mt-2 text-sm leading-relaxed text-base-content/65">Choose a theme for this browser. Changes apply immediately and do not affect other devices.</p>
          <div class="mt-6 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Colour theme">
            {#each themes as option}
              <button
                class="flex items-center gap-4 border p-4 text-left transition {theme === option.id ? 'border-primary bg-primary/10' : 'border-base-300 hover:border-base-content/40'}"
                type="button"
                role="radio"
                aria-checked={theme === option.id}
                onclick={() => selectTheme(option.id)}
              >
                <span class="theme-palette flex overflow-hidden border border-base-content/15" aria-hidden="true">
                  {#each option.colours as colour}<span class="size-5" style={`background:${colour}`}></span>{/each}
                </span>
                <span class="min-w-0 flex-1"><span class="block text-sm font-semibold">{option.name}</span><span class="mt-0.5 block text-xs text-base-content/55">{option.description}</span></span>
                <span class="theme-selection size-3 border border-base-content/40 {theme === option.id ? 'bg-primary ring-2 ring-primary/25 ring-offset-2 ring-offset-base-100' : ''}" aria-hidden="true"></span>
              </button>
            {/each}
          </div>
        </div>
      </section>

      <section class="card border border-base-300 bg-base-100 shadow-sm">
        <div class="card-body gap-0 p-5 sm:p-7">
          <h2 class="card-title">TMDB catalogue</h2>
          <p class="mt-2 text-sm leading-relaxed text-base-content/65">Used for discovery, artwork, search, seasons, and episodes.</p>
          <label class="mt-6 grid gap-2">
            <span class="text-sm font-medium">API read access token</span>
            <input class="input input-bordered w-full" bind:value={form.tmdbToken} type="password" placeholder="TMDB bearer token" autocomplete="off" />
          </label>
        </div>
      </section>

      <section class="card border border-base-300 bg-base-100 shadow-sm">
        <div class="card-body gap-0 p-5 sm:p-7">
          <h2 class="card-title">NZB indexer</h2>
          <p class="mt-2 text-sm leading-relaxed text-base-content/65">A Newznab-compatible indexer used to find releases.</p>

          <div class="mt-6 grid gap-5 md:grid-cols-2">
            <label class="grid gap-2">
              <span class="text-sm font-medium">Indexer URL</span>
              <input class="input input-bordered w-full" bind:value={form.indexerUrl} type="url" placeholder="https://api.example-indexer.com" />
            </label>
            <label class="grid gap-2">
              <span class="text-sm font-medium">API key</span>
              <input class="input input-bordered w-full" bind:value={form.indexerKey} type="password" placeholder="Indexer API key" />
            </label>
          </div>

          <div class="mt-6 grid gap-5 border-t border-base-300 pt-6 md:grid-cols-2">
            <label class="grid content-start gap-2">
              <span class="text-sm font-medium">Playback preference</span>
              <select class="select select-bordered w-full" bind:value={form.playbackQuality}><option value="fast">Start fastest</option><option value="balanced">Balanced</option><option value="quality">Best quality</option></select>
              <span class="text-xs leading-relaxed text-base-content/55">Fastest favours browser-friendly files over large archives.</span>
            </label>
            <label class="grid content-start gap-2">
              <span class="text-sm font-medium">Parallel connections</span>
              <input class="input input-bordered w-full" bind:value={form.maxConnections} type="number" min="1" max="50" />
              <span class="text-xs leading-relaxed text-base-content/55">Use no more than your provider allows.</span>
            </label>
          </div>

          <label class="mt-6 flex cursor-pointer items-start gap-3 border-t border-base-300 pt-6">
            <input class="checkbox checkbox-sm mt-0.5 shrink-0" type="checkbox" bind:checked={form.manualReleaseSelection} />
            <span><span class="block text-sm font-medium">Choose releases manually</span><span class="mt-1 block text-sm leading-relaxed text-base-content/65">Show ranked results before playback instead of selecting one automatically.</span></span>
          </label>
        </div>
      </section>

      <section class="card border border-base-300 bg-base-100 shadow-sm">
        <div class="card-body gap-0 p-5 sm:p-7">
          <h2 class="card-title">Playback experience</h2>
          <p class="mt-2 text-sm leading-relaxed text-base-content/65">Choose how much technical information Watchhouse shows while preparing a title.</p>

          <label class="mt-6 flex cursor-pointer items-start gap-3 border-y border-base-300 py-5">
            <input class="checkbox checkbox-sm mt-0.5 shrink-0" type="checkbox" bind:checked={form.detailedPlaybackProgress} />
            <span><span class="block text-sm font-medium">Detailed playback progress</span><span class="mt-1 block text-sm leading-relaxed text-base-content/65">Show release checks, preparation stages, percentages, and download speed.</span></span>
          </label>

          <label class="mt-5 flex cursor-pointer items-start gap-3 border-b border-base-300 pb-5">
            <input class="checkbox checkbox-sm mt-0.5 shrink-0" type="checkbox" bind:checked={form.playbackDiagnostics} />
            <span><span class="block text-sm font-medium">Playback diagnostics</span><span class="mt-1 block text-sm leading-relaxed text-base-content/65">Show live background-job events, selected release details, stream strategy, and browser video state on watch pages.</span></span>
          </label>

          <label class="mt-5 grid max-w-sm gap-2">
            <span class="text-sm font-medium">Untagged English audio track</span>
            <input class="input input-bordered w-full" bind:value={form.untaggedAudioTrack} type="number" min="1" max="8" />
            <span class="text-xs leading-relaxed text-base-content/55">Used only when no audio track is labelled English. Track 2 is the common dual-audio fallback.</span>
          </label>

          <label class="mt-6 grid max-w-sm gap-2">
            <span class="text-sm font-medium">Clear inactive files after</span>
            <input class="input input-bordered w-full" bind:value={form.cacheRetentionHours} type="number" min="1" max="168" />
            <span class="text-xs leading-relaxed text-base-content/55">Hours; active playback files are cleared automatically.</span>
          </label>
        </div>
      </section>

      <section class="card border border-base-300 bg-base-100 shadow-sm">
        <div class="card-body gap-0 p-5 sm:p-7">
          <h2 class="card-title">Usenet provider</h2>
          <p class="mt-2 text-sm leading-relaxed text-base-content/65">Credentials are used only when testing availability or streaming a release.</p>
          <div class="mt-6 grid gap-5 md:grid-cols-2">
            <label class="grid gap-2"><span class="text-sm font-medium">Server host</span><input class="input input-bordered w-full" bind:value={form.usenetHost} placeholder="news.example.com" /></label>
            <label class="grid gap-2"><span class="text-sm font-medium">Port</span><input class="input input-bordered w-full" bind:value={form.usenetPort} type="number" placeholder="563" /></label>
            <label class="grid gap-2"><span class="text-sm font-medium">Username</span><input class="input input-bordered w-full" bind:value={form.usenetUser} autocomplete="username" /></label>
            <label class="grid gap-2"><span class="text-sm font-medium">Password</span><input class="input input-bordered w-full" bind:value={form.usenetPass} type="password" autocomplete="current-password" /></label>
          </div>
        </div>
      </section>

      <div class="flex flex-wrap justify-end gap-3 border-t border-base-300 pt-6">
        <button class="btn btn-ghost" type="button" onclick={clear}>Clear settings</button>
        <button class="btn btn-outline" type="button" onclick={testConnection}>Test Usenet</button>
        <button class="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
      </div>
    </form>
  {/if}
</div>
