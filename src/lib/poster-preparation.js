// Only Continue Watching cards supply an item. Hover/focus is debounced;
// touch scrolling and simply rendering a shelf do not trigger provider work.
export function preparePoster(node, item) {
  let timer, prepared = false;
  const start = () => {
    if (!item || prepared || !navigator.onLine || navigator.connection?.saveData) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      prepared = true;
      void fetch('/api/play/prewarm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: item.id, type: item.type, season: item.season, episode: item.episode }) }).catch(() => { prepared = false; });
    }, 350);
  };
  const pointer = event => { if (event.pointerType !== 'touch') start(); };
  const stop = () => clearTimeout(timer);
  node.addEventListener('pointerenter', pointer);
  node.addEventListener('pointerleave', stop);
  node.addEventListener('focusin', start);
  node.addEventListener('focusout', stop);
  return { update(next) { stop(); if (JSON.stringify(item) !== JSON.stringify(next)) prepared = false; item = next; }, destroy() { stop(); node.removeEventListener('pointerenter', pointer); node.removeEventListener('pointerleave', stop); node.removeEventListener('focusin', start); node.removeEventListener('focusout', stop); } };
}
