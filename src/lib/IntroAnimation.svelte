<script>
  import { onMount } from 'svelte';

  const STORAGE_KEY = 'watchhouse-intro-seen-v1';
  let visible = $state(false);
  let timer;
  let appShell;

  function dismiss() {
    clearTimeout(timer);
    visible = false;
    appShell?.removeAttribute('inert');
    document.documentElement.classList.remove('watchhouse-intro-active');
  }

  function handleKeydown(event) {
    if (visible && event.key === 'Escape') dismiss();
  }

  onMount(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY)) return;
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {}

    visible = true;
    appShell = document.querySelector('.watchhouse-shell');
    appShell?.setAttribute('inert', '');
    document.documentElement.classList.add('watchhouse-intro-active');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    timer = setTimeout(dismiss, reducedMotion ? 700 : 2800);

    return () => {
      clearTimeout(timer);
      appShell?.removeAttribute('inert');
      document.documentElement.classList.remove('watchhouse-intro-active');
    };
  });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visible}
  <div class="intro" role="dialog" aria-modal="true" aria-label="Welcome to Watchhouse">
    <div class="intro-content">
      <div class="intro-meta"><p>Private screening room</p><span aria-hidden="true">Est. 2026</span></div>
      <div class="intro-stage">
        <p class="intro-title">Watchhouse</p>
        <p class="intro-copy">Films and series, gathered in one quiet place.</p>
      </div>
      <div class="intro-progress" aria-hidden="true"><span></span></div>
    </div>

    <button class="intro-skip" type="button" onclick={dismiss} aria-label="Skip Watchhouse intro">Skip</button>
  </div>
{/if}

<style>
  :global(html.watchhouse-intro-active) { overflow: hidden; }

  .intro {
    position: fixed;
    z-index: 1000;
    inset: 0;
    display: grid;
    align-items: center;
    overflow: hidden;
    isolation: isolate;
    color: var(--color-base-content);
    background:
      radial-gradient(circle at 16% 0%, color-mix(in srgb, var(--color-base-content) 3%, transparent), transparent 32rem),
      var(--color-base-200);
    animation: intro-exit 450ms 2.35s cubic-bezier(.7, 0, .84, 0) both;
  }

  .intro::before {
    position: absolute;
    z-index: -1;
    inset: 0;
    background: linear-gradient(90deg, transparent 49.95%, color-mix(in srgb, var(--color-base-content) 4%, transparent) 50%, transparent 50.05%);
    content: '';
  }

  .intro-content {
    width: min(90rem, calc(100% - clamp(2.5rem, 9vw, 7.5rem)));
    margin-inline: auto;
  }

  .intro-meta {
    display: flex;
    justify-content: space-between;
    gap: 2rem;
    padding-bottom: 1rem;
    color: color-mix(in srgb, var(--color-base-content) 42%, transparent);
    font-size: .64rem;
    font-weight: 600;
    letter-spacing: .23em;
    text-transform: uppercase;
    animation: intro-copy-in 500ms 150ms ease-out both;
  }

  .intro-stage {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: clamp(2rem, 7vw, 8rem);
    padding-block: clamp(2.5rem, 7vw, 6rem);
    border-block: 1px solid color-mix(in srgb, var(--color-base-content) 13%, transparent);
  }

  .intro-title {
    font-family: var(--font-display);
    font-size: clamp(3.4rem, 10vw, 9rem);
    font-weight: 400;
    letter-spacing: -.055em;
    line-height: .85;
    animation: intro-title-in 750ms 250ms cubic-bezier(.22, 1, .36, 1) both;
  }

  .intro-copy {
    max-width: 18rem;
    color: color-mix(in srgb, var(--color-base-content) 52%, transparent);
    font-size: .85rem;
    line-height: 1.7;
    animation: intro-copy-in 600ms 550ms ease-out both;
  }

  .intro-progress { height: 1px; margin-top: 1rem; overflow: hidden; background: color-mix(in srgb, var(--color-base-content) 8%, transparent); }
  .intro-progress span { display: block; width: 100%; height: 100%; background: var(--color-primary); transform-origin: left; animation: intro-progress 2.1s 180ms cubic-bezier(.4, 0, .2, 1) both; }

  .intro-skip {
    position: absolute;
    right: clamp(1.5rem, 5vw, 4.5rem);
    bottom: clamp(1.5rem, 5vw, 4rem);
    border-bottom: 1px solid transparent;
    color: color-mix(in srgb, var(--color-base-content) 46%, transparent);
    font-size: .68rem;
    font-weight: 600;
    letter-spacing: .2em;
    text-transform: uppercase;
    animation: intro-copy-in .5s 700ms ease-out both;
  }
  .intro-skip:hover,
  .intro-skip:focus-visible { border-color: currentColor; color: var(--color-base-content); }

  @keyframes intro-exit { to { opacity: 0; visibility: hidden; transform: translateY(-.75rem); } }
  @keyframes intro-copy-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes intro-title-in { from { opacity: 0; transform: translateY(1.2rem); } to { opacity: 1; transform: translateY(0); } }
  @keyframes intro-progress { from { transform: scaleX(0); } to { transform: scaleX(1); } }

  @media (max-width: 39.99rem) {
    .intro-stage { align-items: start; flex-direction: column; }
    .intro-copy { max-width: 15rem; }
    .intro-meta span { display: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .intro { animation: intro-exit 150ms 550ms ease-out both !important; }
  }
</style>
