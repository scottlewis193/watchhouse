<script>
  import { onMount } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';
  let { offline = false } = $props();
  let menu;
  let menuButton;
  let open = $state(false);
  const links = [
    { label: 'Home', href: '/', path: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z' },
    { label: 'Library', href: '/library', path: 'M4 4h5v16H4zM13 4l5-1 3 16-5 1z' },
    { label: 'Downloads', href: '/downloads', path: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5' },
    { label: 'Settings', href: '/settings', path: 'M4 7h16M4 17h16M8 4v6m8 4v6' }
  ];
  const active = href => href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);
  function closeMenu() { menu?.close(); }
  afterNavigate(closeMenu);
  onMount(() => {
    const desktop = window.matchMedia('(min-width: 768px)');
    const resized = () => { if (desktop.matches) closeMenu(); };
    desktop.addEventListener('change', resized);
    return () => desktop.removeEventListener('change', resized);
  });
</script>

{#snippet navigation(mobile = false)}
  <nav class:rail-links={!mobile} class:drawer-links={mobile} aria-label="Main navigation">
    {#each links as link}
      <a href={link.href} class:active={active(link.href)} aria-current={active(link.href) ? 'page' : undefined} aria-label={link.label} title={link.label} onclick={closeMenu}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={link.path} /></svg>
        <span class:rail-tooltip={!mobile}>{link.label}</span>
      </a>
    {/each}
  </nav>
{/snippet}

<aside class="desktop-rail">
  <a class="rail-brand" href={offline ? '/library?offline=1' : '/'} aria-label="Watchhouse home" title="Watchhouse">WH</a>
  {@render navigation()}
</aside>
<button class="mobile-menu-button" bind:this={menuButton} type="button" aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={open} aria-controls="mobile-navigation" onclick={() => { menu.showModal(); open = true; }}>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
</button>
<dialog id="mobile-navigation" class="mobile-navigation" bind:this={menu} aria-label="Navigation" onclose={() => { open = false; menuButton?.focus(); }} onclick={event => { if (event.target === menu) closeMenu(); }}>
  <div class="drawer-content">
    <div class="drawer-heading"><span>Watchhouse</span><button type="button" aria-label="Close navigation" onclick={closeMenu}>✕</button></div>
    {@render navigation(true)}
  </div>
</dialog>

<style>
  .desktop-rail { position: fixed; inset: 0 auto 0 0; width: 5rem; z-index: 40; display: flex; flex-direction: column; align-items: center; gap: 3rem; padding: 1.5rem 0; background: var(--color-base-100); border-right: 1px solid var(--color-base-300); }
  .rail-brand { font-family: var(--font-display); font-size: 1.1rem; letter-spacing: .08em; font-weight: 500; }
  svg { width: 1.35rem; height: 1.35rem; flex-shrink: 0; }
  nav a { display: flex; align-items: center; position: relative; color: color-mix(in srgb, var(--color-base-content) 55%, transparent); transition: color .15s; }
  nav a:hover, nav a:focus-visible, nav a.active { color: var(--color-base-content); }
  a:focus-visible, button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 4px; }
  .rail-links { display: flex; flex: 1; flex-direction: column; gap: .75rem; }
  .rail-links a { width: 3rem; height: 3rem; justify-content: center; }
  .rail-links a:last-child { margin-top: auto; }
  .rail-links a.active::before { content: ''; position: absolute; width: 1px; height: 1.4rem; left: -1rem; background: var(--color-base-content); }
  .rail-tooltip { position: absolute; left: calc(100% + 1rem); padding: .45rem .7rem; border: 1px solid var(--color-base-300); background: var(--color-base-100); color: var(--color-base-content); font-size: .65rem; text-transform: uppercase; letter-spacing: .12em; white-space: nowrap; pointer-events: none; opacity: 0; }
  a:hover .rail-tooltip, a:focus-visible .rail-tooltip { opacity: 1; }
  .mobile-menu-button { display: none; }
  .mobile-navigation { padding: 0; border: 0; max-height: 100dvh; height: 100dvh; width: min(19rem, 85vw); max-width: 85vw; margin: 0; background: var(--color-base-100); color: var(--color-base-content); }
  .mobile-navigation::backdrop { background: rgb(0 0 0 / .65); backdrop-filter: blur(3px); }
  .drawer-content { min-height: 100%; padding: 1.5rem; }
  .drawer-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2.5rem; font-family: var(--font-display); font-weight: 500; text-transform: uppercase; letter-spacing: .2em; padding-bottom: 1rem; border-bottom: 1px solid var(--color-base-300); }
  .drawer-heading button { width: 2.75rem; height: 2.75rem; border: 1px solid var(--color-base-300); }
  .drawer-links { display: grid; gap: .5rem; }
  .drawer-links a { gap: 1rem; padding: 1.25rem 0; font-size: .7rem; text-transform: uppercase; letter-spacing: .14em; border-bottom: 1px solid var(--color-base-300); }
  .drawer-links a.active { border-bottom-color: var(--color-base-content); }
  @media (max-width: 767px) {
    .desktop-rail { display: none; }
    .mobile-menu-button { display: grid; place-items: center; position: absolute; top: 1rem; left: 1rem; width: 2.75rem; height: 2.75rem; z-index: 30; border: 1px solid var(--color-base-300); background: var(--color-base-100); }
  }
</style>
