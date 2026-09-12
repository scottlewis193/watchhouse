<script>
  import '../app.css';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AppNavigation from '$lib/AppNavigation.svelte';
  import IntroAnimation from '$lib/IntroAnimation.svelte';
  let { children } = $props();
  let offline = $state(false);
  let searchInput;
  const isWatchRoute = $derived(page.url.pathname === '/watch' || page.url.pathname.startsWith('/watch/'));

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
    const navigationRoot = document.querySelector('dialog[open]') || document;
    const candidates = [...navigationRoot.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), video[controls]')]
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
    if (document.querySelector('dialog[open]') || isWatchRoute || !searchInput || searchInput.disabled) return;
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
</script>

<svelte:window onkeydown={handleArrowNavigation} onkeydowncapture={handleGlobalShortcut} />

<svelte:head><title>Watchhouse</title><meta name="description" content="A private media discovery interface" /></svelte:head>

<IntroAnimation />

<div class="watchhouse-shell min-h-screen bg-base-200 text-base-content" class:watchhouse-watch={isWatchRoute} class:with-navigation={!isWatchRoute}>
  {#if offline}<div class="bg-warning px-4 py-2 text-center text-xs font-semibold tracking-wide text-warning-content">OFFLINE MODE · ONLY DOWNLOADED TITLES ARE AVAILABLE</div>{/if}
  {#if !isWatchRoute}
  <AppNavigation {offline} />
  <header class="app-toolbar">
    <div class="app-toolbar-inner mx-auto flex max-w-[90rem] items-center justify-center px-5 sm:px-8 lg:px-12">
      <form class="nav-search" class:opacity-40={offline} action="/" method="get" role="search">
        <svg class="size-4 shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
        <input class="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" bind:this={searchInput} name="q" type="search" value={page.url.searchParams.get('q') || ''} placeholder={offline ? 'Search unavailable offline' : 'Search'} aria-label="Search movies and shows" disabled={offline} />
      </form>
    </div>
  </header>
  {/if}
  <main class="app-main mx-auto max-w-[90rem] px-5 py-7 sm:px-8 sm:py-9 lg:px-12 lg:py-10" class:watch-main={isWatchRoute}>{@render children()}</main>
</div>
