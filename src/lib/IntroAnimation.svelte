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
    timer = setTimeout(dismiss, reducedMotion ? 900 : 3900);

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
    <div class="intro-grain" aria-hidden="true"></div>
    <div class="intro-glow intro-glow-left" aria-hidden="true"></div>
    <div class="intro-glow intro-glow-right" aria-hidden="true"></div>
    <div class="intro-frame intro-frame-outer" aria-hidden="true"></div>
    <div class="intro-frame intro-frame-inner" aria-hidden="true"></div>

    <div class="intro-content">
      <div class="intro-rule" aria-hidden="true"></div>
      <svg class="intro-mark" viewBox="0 0 512 512" aria-hidden="true">
        <rect class="intro-mark-frame" x="64" y="64" width="384" height="384" rx="8" fill="none" stroke="currentColor" stroke-width="18" />
        <path class="intro-mark-letters" fill="currentColor" d="M140 206h20l15 81 18-55h18l18 55 15-81h20l-24 100h-21l-17-52-17 52h-21zm144 0h22v39h44v-39h22v100h-22v-42h-44v42h-22z" />
      </svg>
      <p class="intro-kicker">Your private screening room</p>
      <p class="intro-title">Watchhouse</p>
      <div class="intro-rule intro-rule-bottom" aria-hidden="true"></div>
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
    place-items: center;
    overflow: hidden;
    isolation: isolate;
    color: #e7c98e;
    background:
      radial-gradient(circle at 50% 45%, rgb(52 45 31 / 46%), transparent 29rem),
      linear-gradient(145deg, #121210, #080807 70%);
    animation: intro-exit 650ms 3.25s cubic-bezier(.7, 0, .84, 0) both;
  }

  .intro::before,
  .intro::after {
    position: absolute;
    z-index: -1;
    width: 70vmax;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgb(201 169 110 / 42%), transparent);
    content: '';
    animation: intro-beam 2.6s .15s cubic-bezier(.22, 1, .36, 1) both;
  }
  .intro::before { transform: rotate(32deg); }
  .intro::after { transform: rotate(-32deg); animation-delay: .3s; }

  .intro-grain {
    position: absolute;
    inset: -35%;
    opacity: .13;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.45'/%3E%3C/svg%3E");
    animation: intro-grain-shift .24s steps(2) infinite;
    pointer-events: none;
  }

  .intro-glow {
    position: absolute;
    width: 34rem;
    height: 34rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-primary) 13%, transparent);
    filter: blur(90px);
    animation: intro-glow 3s ease-out both;
  }
  .intro-glow-left { top: -18rem; left: -12rem; }
  .intro-glow-right { right: -16rem; bottom: -21rem; animation-delay: .25s; }

  .intro-frame {
    position: absolute;
    border: 1px solid rgb(201 169 110 / 18%);
    animation: intro-frame-in 1.4s .2s cubic-bezier(.22, 1, .36, 1) both;
  }
  .intro-frame-outer { inset: clamp(1rem, 4vw, 3rem); }
  .intro-frame-inner { inset: clamp(1.45rem, 5vw, 4rem); border-color: rgb(201 169 110 / 8%); animation-delay: .32s; }

  .intro-content {
    display: grid;
    justify-items: center;
    width: min(78vw, 34rem);
    text-align: center;
  }

  .intro-mark {
    width: clamp(5.5rem, 15vw, 8rem);
    filter: drop-shadow(0 0 22px rgb(201 169 110 / 24%));
    animation: intro-mark-in 1.1s .42s cubic-bezier(.16, 1, .3, 1) both;
  }
  .intro-mark-frame {
    stroke-dasharray: 1536;
    stroke-dashoffset: 1536;
    animation: intro-draw 1.25s .35s cubic-bezier(.65, 0, .35, 1) forwards;
  }
  .intro-mark-letters { animation: intro-letters-in .75s 1.18s cubic-bezier(.16, 1, .3, 1) both; }

  .intro-kicker {
    margin-top: 1.5rem;
    color: rgb(238 234 224 / 55%);
    font-size: .62rem;
    font-weight: 600;
    letter-spacing: .3em;
    text-transform: uppercase;
    animation: intro-copy-in .7s 1.45s ease-out both;
  }
  .intro-title {
    margin-top: .45rem;
    color: #f2eee5;
    font-size: clamp(2.3rem, 7vw, 4.7rem);
    font-weight: 600;
    letter-spacing: -.045em;
    line-height: 1;
    text-shadow: 0 14px 42px rgb(0 0 0 / 80%);
    animation: intro-title-in .9s 1.28s cubic-bezier(.16, 1, .3, 1) both;
  }

  .intro-rule {
    width: 100%;
    height: 1px;
    margin-bottom: 2rem;
    background: linear-gradient(90deg, transparent, rgb(201 169 110 / 55%), transparent);
    transform-origin: center;
    animation: intro-rule-in 1.1s .7s cubic-bezier(.22, 1, .36, 1) both;
  }
  .intro-rule-bottom { margin-top: 2rem; margin-bottom: 0; animation-delay: 1.05s; }

  .intro-skip {
    position: absolute;
    right: clamp(1.5rem, 5vw, 4.5rem);
    bottom: clamp(1.5rem, 5vw, 4rem);
    border-bottom: 1px solid transparent;
    color: rgb(238 234 224 / 52%);
    font-size: .68rem;
    font-weight: 600;
    letter-spacing: .2em;
    text-transform: uppercase;
    animation: intro-copy-in .6s 1.9s ease-out both;
  }
  .intro-skip:hover,
  .intro-skip:focus-visible { border-color: currentColor; color: #f2eee5; }

  @keyframes intro-exit { to { opacity: 0; visibility: hidden; transform: scale(1.035); } }
  @keyframes intro-beam { from { opacity: 0; scale: .15 1; } 35% { opacity: 1; } to { opacity: 0; scale: 1 1; } }
  @keyframes intro-grain-shift { 0% { transform: translate(0); } 25% { transform: translate(2%, -1%); } 50% { transform: translate(-1%, 2%); } 75% { transform: translate(1%, 1%); } }
  @keyframes intro-glow { from { opacity: 0; transform: scale(.7); } to { opacity: 1; transform: scale(1); } }
  @keyframes intro-frame-in { from { opacity: 0; transform: scale(1.07); } to { opacity: 1; transform: scale(1); } }
  @keyframes intro-mark-in { from { opacity: 0; transform: scale(.74) rotate(-7deg); } to { opacity: 1; transform: scale(1) rotate(0); } }
  @keyframes intro-draw { to { stroke-dashoffset: 0; } }
  @keyframes intro-letters-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes intro-copy-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes intro-title-in { from { opacity: 0; filter: blur(12px); letter-spacing: .04em; transform: scale(.94); } to { opacity: 1; filter: blur(0); letter-spacing: -.045em; transform: scale(1); } }
  @keyframes intro-rule-in { from { opacity: 0; transform: scaleX(0); } to { opacity: 1; transform: scaleX(1); } }

  @media (prefers-reduced-motion: reduce) {
    .intro { animation: intro-exit 180ms 700ms ease-out both !important; }
    .intro-grain { animation: none !important; }
  }
</style>
