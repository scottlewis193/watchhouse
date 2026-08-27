<script>
  import '../app.css';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import IntroAnimation from '$lib/IntroAnimation.svelte';
  let { children } = $props();
  let offline = $state(false);
  let searchInput;

  onMount(() => {
    const update = () => {
      offline = !navigator.onLine;
      if (offline && page.url.pathname === '/') void goto('/library?offline=1', { replaceState: true });
    };
    update(); window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  });

  function handleArrowNavigation(event) {
    if (event.defaultPrevented) return;
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

  function handleGlobalShortcut(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.key !== '/') return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.matches('input, textarea, select, button') || target.isContentEditable)) return;
    if (!searchInput || searchInput.disabled) return;
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
</script>

<svelte:window onkeydown={handleArrowNavigation} onkeydowncapture={handleGlobalShortcut} />

<svelte:head><title>Watchhouse</title><meta name="description" content="A private media discovery interface" /></svelte:head>

<IntroAnimation />

<div class="watchhouse-shell min-h-screen bg-base-200 text-base-content">
  {#if offline}<div class="bg-warning px-4 py-2 text-center text-xs font-semibold tracking-wide text-warning-content">OFFLINE MODE · ONLY DOWNLOADED TITLES ARE AVAILABLE</div>{/if}
  <header class="app-header">
    <div class="app-header-inner mx-auto grid max-w-[90rem] items-center gap-x-8 gap-y-4 px-5 sm:px-8 lg:px-12">
      <a class="brand-link" href={offline ? '/library?offline=1' : '/'}>Watchhouse</a>
      <nav class="main-nav" aria-label="Main navigation">
        <a class="nav-link" class:nav-link-active={page.url.pathname === '/'} href="/">Home</a>
        <a class="nav-link" class:nav-link-active={page.url.pathname.startsWith('/library')} href="/library">Library</a>
        <a class="nav-link" class:nav-link-active={page.url.pathname.startsWith('/settings')} href="/settings">Settings</a>
      </nav>
      <form class="nav-search" class:opacity-40={offline} action="/" method="get" role="search">
        <svg class="size-4 shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
        <input class="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" bind:this={searchInput} name="q" type="search" value={page.url.searchParams.get('q') || ''} placeholder={offline ? 'Search unavailable offline' : 'Search'} aria-label="Search movies and shows" disabled={offline} />
      </form>
    </div>
  </header>
  <main class="app-main mx-auto max-w-[90rem] px-5 py-10 sm:px-8 sm:py-14 lg:px-12 lg:py-16">{@render children()}</main>
  <footer class="app-footer mx-auto flex max-w-[90rem] flex-col gap-4 border-t border-base-300 px-5 py-8 text-xs text-base-content/45 sm:px-8 md:flex-row md:items-center md:justify-between lg:px-12">
    <p class="tracking-[0.18em]">WATCHHOUSE · PRIVATE SCREENING ROOM</p>
    <a class="flex items-center gap-3 hover:text-base-content/75" href="https://www.themoviedb.org" target="_blank" rel="noreferrer">
      <img class="h-7 w-7" src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_1-5bdc75aaebeb75dc7ae79426ddd9be3b2be1e342510f8202baf6bffa71d7f5c4.svg" alt="TMDB" />
      <span class="max-w-sm leading-relaxed">Uses the TMDB API. Not endorsed or certified by TMDB.</span>
    </a>
  </footer>
</div>
