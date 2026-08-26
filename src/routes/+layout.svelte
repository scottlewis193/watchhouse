<script>
  import '../app.css';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  let { children } = $props();
  let offline = $state(false);

  onMount(() => {
    const update = () => {
      offline = !navigator.onLine;
      if (offline && page.url.pathname === '/') void goto('/library?offline=1', { replaceState: true });
    };
    update(); window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  });

  function handleArrowNavigation(event) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    const verticalArrow = ['ArrowUp', 'ArrowDown'].includes(event.key);
    const textInput = target.matches('input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="password"], input[type="number"]');
    if (target.matches('video, textarea') || (target.matches('select') && verticalArrow) || (textInput && !verticalArrow)) return;
    const candidates = [...document.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), video[controls]')]
      .filter(element => !element.hasAttribute('data-spatial-ignore') && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    const current = candidates.includes(target) ? target : null;
    if (!current) { candidates[0]?.focus(); return; }
    const origin = current.getBoundingClientRect(), ox = origin.left + origin.width / 2, oy = origin.top + origin.height / 2;
    const vertical = ['ArrowUp', 'ArrowDown'].includes(event.key), forward = ['ArrowRight', 'ArrowDown'].includes(event.key);
    const choices = candidates.filter(element => element !== current).map(element => {
      const rect = element.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const primary = vertical ? y - oy : x - ox, cross = vertical ? Math.abs(x - ox) : Math.abs(y - oy);
      return { element, primary, score: Math.abs(primary) * 3 + cross };
    }).filter(choice => forward ? choice.primary > 4 : choice.primary < -4).sort((a, b) => a.score - b.score);
    if (!choices.length) return;
    event.preventDefault();
    choices[0].element.focus({ preventScroll: true });
    choices[0].element.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }
</script>

<svelte:window onkeydown={handleArrowNavigation} />

<svelte:head><title>Watchhouse</title><meta name="description" content="A private media discovery interface" /></svelte:head>

<div class="min-h-screen bg-base-200 text-base-content">
  {#if offline}<div class="bg-warning px-4 py-2 text-center text-xs font-semibold tracking-wide text-warning-content">OFFLINE MODE · ONLY DOWNLOADED TITLES ARE AVAILABLE</div>{/if}
  <header class="app-header border-b border-base-300">
    <div class="mx-auto grid min-h-18 max-w-6xl grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-3 sm:gap-6 sm:px-6">
      <a class="brand-link flex items-center gap-3 font-semibold tracking-tight" href={offline ? '/library?offline=1' : '/'}>
        <svg class="brand-mark size-7 shrink-0" viewBox="0 0 512 512" aria-hidden="true">
          <rect x="64" y="64" width="384" height="384" rx="8" fill="none" stroke="currentColor" stroke-width="18" />
          <path fill="currentColor" d="M140 206h20l15 81 18-55h18l18 55 15-81h20l-24 100h-21l-17-52-17 52h-21zm144 0h22v39h44v-39h22v100h-22v-42h-44v42h-22z" />
        </svg>
        Watchhouse
      </a>
      <form class="nav-search order-3 col-span-3 mx-auto flex w-full max-w-xl items-center border-b border-base-content/30 sm:order-none sm:col-span-1" class:opacity-40={offline} action="/" method="get" role="search">
        <input class="input input-ghost min-w-0 flex-1 px-0 text-sm focus:outline-none" name="q" type="search" value={page.url.searchParams.get('q') || ''} placeholder={offline ? 'Search unavailable offline' : 'Search films and series…'} aria-label="Search movies and shows" disabled={offline} />
      </form>
      <nav class="flex items-center justify-end gap-3 text-sm text-base-content/70 sm:gap-5" aria-label="Main navigation"><a class="nav-link" href="/library">Library</a><a class="nav-link" href="/settings">Settings</a></nav>
    </div>
  </header>
  <main class="app-main mx-auto max-w-6xl px-4 py-12 sm:px-6">{@render children()}</main>
  <footer class="app-footer border-t border-base-300 py-7 text-center text-xs text-base-content/50">
    <p class="tracking-wide">WATCHHOUSE · PRIVATE MEDIA LIBRARY</p>
    <a class="mx-auto mt-4 flex w-fit items-center justify-center gap-3 hover:text-base-content/75" href="https://www.themoviedb.org" target="_blank" rel="noreferrer">
      <img class="h-7 w-7" src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_1-5bdc75aaebeb75dc7ae79426ddd9be3b2be1e342510f8202baf6bffa71d7f5c4.svg" alt="TMDB" />
      <span class="max-w-md text-left leading-relaxed">This product uses the TMDB API but is not endorsed or certified by TMDB.</span>
    </a>
  </footer>
</div>
