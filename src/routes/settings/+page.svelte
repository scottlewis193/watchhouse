<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api';

  let form = $state({ tmdbToken: '', indexerUrl: '', indexerKey: '', torrentIndexerUrl: '', torrentIndexerKey: '', usenetHost: '', usenetPort: '563', usenetUser: '', usenetPass: '', manualReleaseSelection: false, autoPlayNextEpisode: true, prepareSeries: true, smartAutoplay: false, detailedPlaybackProgress: false, playbackDiagnostics: false, repairVideoTimeline: false, frameInterpolation: false, playbackQuality: 'balanced', targetResolution: 'auto', untaggedAudioTrack: '2', maxConnections: '4', cacheRetentionHours: '24' });
  let loading = $state(true);
  let saving = $state(false);
  let notice = $state('');
  let noticeType = $state('success');
  let configured = $state(false);
  let bundledTorrent = $state(null);
  let theme = $state('watchhouse');
  const themes = [
    { id: 'watchhouse', name: 'Watchhouse', description: 'Gallery black and ivory', colours: ['#08090a', '#262729', '#ded8cd'] },
    { id: 'midnight', name: 'Midnight', description: 'Deep navy and cyan', colours: ['#0d1722', '#283b4d', '#73c9d8'] },
    { id: 'cinema', name: 'Cinema', description: 'Near-black and red', colours: ['#140f10', '#3e2d2f', '#dc6b61'] },
    { id: 'paper', name: 'Paper', description: 'Warm light and teal', colours: ['#f3efe6', '#d8d0c1', '#326b71'] }
  ];

  onMount(async () => {
    theme = themes.some(option => option.id === document.documentElement.dataset.theme) ? document.documentElement.dataset.theme : 'watchhouse';
    try { applyConfig(await api.get('/api/settings')); }
    catch (e) { show(e.message, 'error'); }
    finally { loading = false; }
  });
  function show(message, type = 'success') { notice = message; noticeType = type; }
  function setupComplete(config) { return Boolean(config.hasTmdbToken && (config.hasTorrentIndexer || config.torrentIndexerUrl || config.indexerUrl && config.usenetHost)); }
  function applyConfig(config) {
    form = { ...form, ...Object.fromEntries(Object.entries(config).filter(([key]) => key in form)) };
    bundledTorrent = config.bundledTorrent || null;
    configured = setupComplete(config);
  }
  async function save() { saving = true; try { applyConfig(await api.put('/api/settings', form)); form.indexerKey = ''; form.torrentIndexerKey = ''; form.usenetPass = ''; form.tmdbToken = ''; show('Settings saved. Credentials remain on this local server.'); } catch (e) { show(e.message, 'error'); } finally { saving = false; } }
  async function testConnection() { try { show('Testing Usenet connection…'); show((await api.post('/api/usenet/test', form)).message); } catch (e) { show(e.message, 'error'); } }
  async function clear() { try { await api.delete('/api/settings'); form = { tmdbToken: '', indexerUrl: '', indexerKey: '', torrentIndexerUrl: '', torrentIndexerKey: '', usenetHost: '', usenetPort: '563', usenetUser: '', usenetPass: '', manualReleaseSelection: false, autoPlayNextEpisode: true, prepareSeries: true, smartAutoplay: false, detailedPlaybackProgress: false, playbackDiagnostics: false, repairVideoTimeline: false, frameInterpolation: false, playbackQuality: 'balanced', targetResolution: 'auto', untaggedAudioTrack: '2', maxConnections: '4', cacheRetentionHours: '24' }; applyConfig(await api.get('/api/settings')); show('Settings cleared. Bundled indexers remain active when enabled.'); } catch (e) { show(e.message, 'error'); } }
  function selectTheme(nextTheme) {
    theme = nextTheme;
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem('watchhouse-theme', nextTheme);
  }
</script>

<svelte:head><title>Settings · Watchhouse</title></svelte:head>

<div class="settings-page mx-auto max-w-5xl">
  <div class="page-tools"><span class="page-eyebrow">Private configuration</span><span class="text-xs font-semibold tracking-wide {configured ? 'text-success' : 'text-warning'}">{configured ? 'CONFIGURED' : bundledTorrent?.active ? 'TMDB TOKEN REQUIRED' : 'SETUP REQUIRED'}</span></div>
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
          <a class="mt-3 flex items-center gap-3 text-xs text-base-content/55 hover:text-base-content" href="https://www.themoviedb.org" target="_blank" rel="noreferrer"><img class="h-7 w-7" src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_1-5bdc75aaebeb75dc7ae79426ddd9be3b2be1e342510f8202baf6bffa71d7f5c4.svg" alt="TMDB" /><span>Uses the TMDB API. Not endorsed or certified by TMDB.</span></a>
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
          <p class="mt-2 text-sm leading-relaxed text-base-content/65">A Newznab-compatible indexer used to find Usenet releases. Optional when using local torrent streaming only. Playback quality and resolution preferences below apply to both sources.</p>

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
              <span class="text-xs leading-relaxed text-base-content/55">Shared limit for all provider activity. One direct stream uses up to 24 connections; downloads use up to 12. Use no more than your provider allows.</span>
            </label>
            <label class="grid content-start gap-2">
              <span class="text-sm font-medium">Target resolution</span>
              <select class="select select-bordered w-full" bind:value={form.targetResolution}><option value="auto">Automatic</option><option value="2160p">2160p (4K)</option><option value="1080p">1080p</option><option value="720p">720p</option></select>
              <span class="text-xs leading-relaxed text-base-content/55">Automatic playback tries this resolution first, then lower resolutions if needed. It skips known higher resolutions. Manual release choices remain available.</span>
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
          <h2 class="card-title">Local torrent streaming</h2>
          <p class="mt-2 text-sm leading-relaxed text-base-content/65">Watchhouse tries local peer-to-peer streaming when a streamable Usenet release is unavailable. No debrid service or debrid account is used. An external Jackett or Prowlarr Torznab feed is an optional override. Leave its URL empty to use bundled public indexers when enabled; otherwise torrent fallback is disabled.</p>
          {#if bundledTorrent?.active}
            <div class="mt-5 border border-success/30 bg-success/5 p-4 text-sm leading-relaxed">
              <p class="font-medium text-success">Bundled public indexers active</p>
              <p class="mt-1 text-base-content/65">Sources: {bundledTorrent.indexers.map(id => ({ limetorrents: 'LimeTorrents', thepiratebay: 'The Pirate Bay', torrentdownloads: 'TorrentDownloads' })[id] || id).join(', ')}. No external URL or API key is required. Public sites may be blocked or temporarily unavailable.</p>
            </div>
          {:else if bundledTorrent?.available}
            <p class="mt-5 text-sm leading-relaxed text-base-content/65">An external Torznab override is active. Clear its URL and save to restore the bundled public indexers: {bundledTorrent.indexers.join(', ')}.</p>
          {:else if bundledTorrent?.enabled}
            <p class="mt-5 text-sm leading-relaxed text-warning">Bundled indexer configuration is not ready. Check the server startup logs; public sources may be temporarily unavailable. You can also configure an external Torznab override below.</p>
          {/if}
          <div class="mt-6 grid gap-5 md:grid-cols-2">
            <label class="grid gap-2">
              <span class="text-sm font-medium">External Torznab URL (optional)</span>
              <input class="input input-bordered w-full" bind:value={form.torrentIndexerUrl} type="url" placeholder="http://localhost:9117/api/v2.0/indexers/all/results/torznab/api" />
              <span class="text-xs leading-relaxed text-base-content/55">Use the full Torznab API URL supplied by your external indexer. Clearing this URL also clears its saved API key. In containers, localhost refers to the Watchhouse server container.</span>
            </label>
            <label class="grid gap-2">
              <span class="text-sm font-medium">External Torznab API key (optional)</span>
              <input class="input input-bordered w-full" bind:value={form.torrentIndexerKey} type="password" placeholder="Blank keeps the key only for an unchanged URL" autocomplete="off" />
            </label>
          </div>
          <p class="mt-5 border-t border-base-300 pt-5 text-sm leading-relaxed text-warning">Peers and trackers can see this server's public IP address, including during magnet metadata lookups. Your browser's connection does not hide the server's peer traffic. Use only sources you are authorised to access and configure any required VPN or network policy on the server itself.</p>
          <p class="mt-3 text-xs leading-relaxed text-base-content/55">Background selection saves release and file metadata only, not full videos. Playback fetches requested video ranges into a bounded temporary memory piece cache. Archives and ambiguous episode files are rejected; supported containers are remuxed or transcoded for browser playback. Availability and start time depend on reachable peers.</p>
        </div>
      </section>

      <section class="card border border-base-300 bg-base-100 shadow-sm">
        <div class="card-body gap-0 p-5 sm:p-7">
          <h2 class="card-title">Playback experience</h2>
          <p class="mt-2 text-sm leading-relaxed text-base-content/65">Choose how playback continues and how much preparation detail Watchhouse shows.</p>

          <label class="mt-6 flex cursor-pointer items-start gap-3 border-y border-base-300 py-5">
            <input class="checkbox checkbox-sm mt-0.5 shrink-0" type="checkbox" bind:checked={form.autoPlayNextEpisode} />
            <span><span class="block text-sm font-medium">Auto-play next episode</span><span class="mt-1 block text-sm leading-relaxed text-base-content/65">Automatically continue with the next episode after the countdown. Enabled by default.</span></span>
          </label>

          <label class="mt-5 flex cursor-pointer items-start gap-3 border-b border-base-300 pb-5">
            <input class="checkbox checkbox-sm mt-0.5 shrink-0" type="checkbox" bind:checked={form.prepareSeries} />
            <span><span class="block text-sm font-medium">Prepare stream selections for the rest of the series</span><span class="mt-1 block text-sm leading-relaxed text-base-content/65">Enabled by default. After playback starts, select streamable releases for the remaining aired episodes using your saved quality and resolution preferences. Saves release metadata only: no speculative video downloads, archive extraction, or saved Downloads. Each episode begins streaming only when played.</span></span>
          </label>

          <label class="mt-5 flex cursor-pointer items-start gap-3 border-b border-base-300 pb-5">
            <input class="checkbox checkbox-sm mt-0.5 shrink-0" type="checkbox" bind:checked={form.smartAutoplay} />
            <span><span class="block text-sm font-medium">Smart next episode</span><span class="mt-1 block text-sm leading-relaxed text-base-content/65">Look for end-credit frames on this device during the final 5 minutes and start the next-episode countdown early.</span></span>
          </label>

          <label class="mt-5 flex cursor-pointer items-start gap-3 border-b border-base-300 pb-5">
            <input class="checkbox checkbox-sm mt-0.5 shrink-0" type="checkbox" bind:checked={form.detailedPlaybackProgress} />
            <span><span class="block text-sm font-medium">Detailed playback progress</span><span class="mt-1 block text-sm leading-relaxed text-base-content/65">Show release checks, preparation stages, percentages, and download speed.</span></span>
          </label>

          <label class="mt-5 flex cursor-pointer items-start gap-3 border-b border-base-300 pb-5">
            <input class="checkbox checkbox-sm mt-0.5 shrink-0" type="checkbox" bind:checked={form.playbackDiagnostics} />
            <span><span class="block text-sm font-medium">Playback diagnostics</span><span class="mt-1 block text-sm leading-relaxed text-base-content/65">Show live release selection with rejection reasons, background-job events, stream strategy, and browser video state on watch pages.</span></span>
          </label>

          <label class="mt-5 flex cursor-pointer items-start gap-3 border-b border-base-300 pb-5">
            <input class="checkbox checkbox-sm mt-0.5 shrink-0" type="checkbox" bind:checked={form.repairVideoTimeline} />
            <span><span class="block text-sm font-medium">Repair video timeline gaps</span><span class="mt-1 block text-sm leading-relaxed text-base-content/65">Repair detected video timestamp gaps while audio continues by repeating frames, without blending neighbouring images. Healthy streams retain their original frames. Downloaded copies receive a full timeline scan. Repairs use additional CPU; disabled by default.</span></span>
          </label>

          <label class="mt-5 flex cursor-pointer items-start gap-3">
            <input class="checkbox checkbox-sm mt-0.5 shrink-0" type="checkbox" bind:checked={form.frameInterpolation} />
            <span><span class="block text-sm font-medium">Frame interpolation</span><span class="mt-1 block text-xs leading-relaxed text-base-content/65">Generate intermediate frames for smoother 60 FPS playback. Uses substantial server CPU and may increase buffering or introduce motion artefacts. Off by default. Applies when playback starts or restarts; saved copies retain their original frame rate.</span></span>
          </label>

          <label class="mt-5 grid max-w-sm gap-2">
            <span class="text-sm font-medium">Untagged English audio track</span>
            <input class="input input-bordered w-full" bind:value={form.untaggedAudioTrack} type="number" min="1" max="8" />
            <span class="text-xs leading-relaxed text-base-content/55">Used only when no audio track is labelled English. Track 2 is the common dual-audio fallback.</span>
          </label>

          <label class="mt-6 grid max-w-sm gap-2">
            <span class="text-sm font-medium">Clear inactive files after</span>
            <input class="input input-bordered w-full" bind:value={form.cacheRetentionHours} type="number" min="1" max="168" />
            <span class="text-xs leading-relaxed text-base-content/55">Hours; inactive temporary playback files are cleared automatically. Verified release selections and media metadata are kept until you clear the movie or episode cache. Saved Downloads are kept until you delete them.</span>
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
