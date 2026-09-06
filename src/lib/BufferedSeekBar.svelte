<script>
  let { position = 0, duration = 0, buffered = [], valueText = '', oninput, onchange } = $props();
  let played = $derived(duration > 0 ? Math.max(0, Math.min(100, position / duration * 100)) : 0);
</script>

<div class="seek-bar">
  <div class="seek-track" aria-hidden="true">
    {#each buffered as range}
      <span class="seek-buffered" style:left={`${range.left}%`} style:width={`${range.width}%`}></span>
    {/each}
    <span class="seek-played" style:width={`${played}%`}></span>
  </div>
  <input aria-label="Playback position" aria-valuetext={valueText} type="range" min="0" max={duration || 0} step="0.1" value={position} disabled={!duration} {oninput} {onchange} onkeydown={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.stopPropagation(); }} />
</div>

<style>
  .seek-bar { position: relative; height: 1rem; }
  .seek-track { position: absolute; top: calc(50% - 2px); right: 6px; left: 6px; height: 4px; overflow: hidden; background: rgb(255 255 255 / 18%); pointer-events: none; }
  .seek-track span { position: absolute; top: 0; height: 100%; }
  .seek-buffered { background: rgb(255 255 255 / 40%); }
  .seek-played { left: 0; background: rgb(255 255 255 / 90%); }
  input { position: relative; display: block; appearance: none; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; background: transparent; cursor: pointer; }
  input:focus-visible { outline: 2px solid white; outline-offset: 4px; }
  input:disabled { cursor: default; }
  input::-webkit-slider-runnable-track { height: 4px; background: transparent; }
  input::-moz-range-track { height: 4px; background: transparent; }
  input::-moz-range-progress { background: transparent; }
  input::-webkit-slider-thumb { appearance: none; width: 12px; height: 12px; margin-top: -4px; border: 0; border-radius: 50%; background: white; }
  input::-moz-range-thumb { width: 12px; height: 12px; border: 0; border-radius: 50%; background: white; }
</style>
