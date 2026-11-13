export function shouldPrewarmResume({ position = 0, online = true, saveData = false, offlineMode = false, manualReleaseSelection = false, shouldStartImmediately = false } = {}) {
  return position > 0 && online && !saveData && !offlineMode && !manualReleaseSelection && !shouldStartImmediately;
}

const pendingPreparations = new Map();

function networkAllowsPreparation() {
  return globalThis.navigator?.onLine !== false && !globalThis.navigator?.connection?.saveData;
}

function allowsPlayIntent(item) {
  return item && ['movie', 'tv'].includes(item.type) && Number.isInteger(Number(item.id)) && Number(item.id) > 0
    && typeof item.title === 'string' && item.title.trim()
    && (item.type === 'movie' || [item.season, item.episode].every(value => Number.isInteger(Number(value)) && Number(value) > 0))
    && !(item.position > 0) && !item.manualReleaseSelection && !item.offlineMode && !item.downloaded && networkAllowsPreparation();
}

export function prewarmPlayback(item, { fetcher = fetch, timeoutMs = 1500, intent = false, requestId, signal } = {}) {
  if (!networkAllowsPreparation()) {
    return Promise.reject(new Error('Playback preparation is disabled by the network policy.'));
  }
  if (intent && (!allowsPlayIntent(item) || typeof requestId !== 'string' || !requestId)) {
    return Promise.reject(new Error('Playback preparation requires an eligible Play intent and request ID.'));
  }
  if (signal?.aborted) return Promise.reject(signal.reason);
  const key = JSON.stringify([item.type, item.id, item.season, item.episode, intent ? requestId : null]);
  const existing = pendingPreparations.get(key);
  if (existing?.fetcher === fetcher) return existing.promise;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('Playback preparation timed out.')), timeoutMs);
  timeout.unref?.();
  const record = { fetcher };
  record.promise = (async () => {
    const response = await fetcher('/api/play/prewarm', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(intent ? { ...item, intent: true, requestId } : { id: item.id, type: item.type, season: item.season, episode: item.episode }),
      keepalive: true, signal: controller.signal
    });
    if (!response.ok) throw new Error(`Playback preparation returned HTTP ${response.status}.`);
    const result = await response.json();
    if (result.prepared !== true) throw new Error('Playback preparation was not accepted.');
    return result;
  })().finally(() => {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    if (pendingPreparations.get(key) === record) pendingPreparations.delete(key);
  });
  pendingPreparations.set(key, record);
  return record.promise;
}

export async function preparePosterNavigation(item, href, navigate, prepare = prewarmPlayback) {
  // Preparation is optional; an acknowledgement must not hold up the player.
  try { void Promise.resolve(prepare(item)).catch(() => {}); } catch {}
  return navigate(href);
}

// Only Continue Watching cards supply an item. Hover/focus is debounced;
// touch scrolling and simply rendering a shelf do not trigger provider work.
export function preparePoster(node, item) {
  let timer, prepared = false, revision = 0;
  const eligible = () => item && !prepared && navigator.onLine && !navigator.connection?.saveData;
  const start = () => {
    if (!eligible()) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!eligible()) return;
      const preparingRevision = revision;
      prepared = true;
      void prewarmPlayback(item).catch(() => { if (revision === preparingRevision) prepared = false; });
    }, 350);
  };
  const pointer = event => { if (event.pointerType !== 'touch') start(); };
  const stop = () => clearTimeout(timer);
  node.addEventListener('pointerenter', pointer);
  node.addEventListener('pointerleave', stop);
  node.addEventListener('focusin', start);
  node.addEventListener('focusout', stop);
  return { update(next) { stop(); if (JSON.stringify(item) !== JSON.stringify(next)) { prepared = false; revision++; } item = next; }, destroy() { stop(); node.removeEventListener('pointerenter', pointer); node.removeEventListener('pointerleave', stop); node.removeEventListener('focusin', start); node.removeEventListener('focusout', stop); } };
}

let activePlayIntent;
let intentSequence = 0;

function cancelPlayIntent(record) {
  if (!record || record.claimed || record.cancelled) return;
  record.cancelled = true;
  clearTimeout(record.timer);
  if (activePlayIntent === record) activePlayIntent = null;
  record.controller.abort(new Error('Play intent abandoned.'));
  if (!record.started) return;
  try {
    void Promise.resolve(fetch('/api/play/prewarm', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: record.requestId }), keepalive: true
    })).catch(() => {});
  } catch {}
}

// Bind only to an actual Play control. Catalogue/card navigation stays immediate
// and never starts new-title work merely because a poster is rendered or hovered.
// Pointer intent gets a brief crossing guard; keyboard focus dispatches next turn.
export function preparePlayIntent(node, item) {
  let record, hovering = false, focused = false, identity = JSON.stringify(item);
  const start = (delayMs = 100) => {
    if (!allowsPlayIntent(item)) return;
    if (record && !record.cancelled) {
      if (record.started || record.claimed || delayMs >= record.delayMs) return;
      clearTimeout(record.timer);
      record.delayMs = delayMs;
      record.timer = setTimeout(record.dispatch, delayMs);
      return;
    }
    cancelPlayIntent(activePlayIntent);
    const preparing = {
      controller: new AbortController(),
      delayMs,
      requestId: globalThis.crypto?.randomUUID?.() || `play-${Date.now().toString(36)}-${++intentSequence}-${Math.random().toString(36).slice(2)}`
    };
    record = activePlayIntent = preparing;
    preparing.dispatch = () => {
      if (preparing.cancelled || preparing.claimed || preparing.started) return;
      if (!allowsPlayIntent(item)) { cancelPlayIntent(preparing); return; }
      preparing.started = true;
      void prewarmPlayback(item, { intent: true, requestId: preparing.requestId, signal: preparing.controller.signal })
        .catch(() => cancelPlayIntent(preparing));
    };
    preparing.timer = setTimeout(preparing.dispatch, delayMs);
  };
  const stop = () => { if (!hovering && !focused) cancelPlayIntent(record); };
  const enter = event => {
    if (event.pointerType === 'touch') return;
    hovering = true; start();
  };
  const leave = () => { hovering = false; stop(); };
  const focus = () => { focused = true; start(0); };
  const blur = event => {
    if (event.relatedTarget && node.contains?.(event.relatedTarget)) return;
    focused = false; stop();
  };
  const claim = event => {
    if (event.defaultPrevented || event.button > 0) return;
    if (activePlayIntent !== record) cancelPlayIntent(activePlayIntent);
    if (!record || record.cancelled) return;
    clearTimeout(record.timer);
    record.claimed = true;
    if (activePlayIntent === record) activePlayIntent = null;
  };
  const policyChanged = () => { if (!allowsPlayIntent(item)) cancelPlayIntent(record); };
  const connection = globalThis.navigator?.connection;
  node.addEventListener('pointerenter', enter);
  node.addEventListener('pointerleave', leave);
  node.addEventListener('focusin', focus);
  node.addEventListener('focusout', blur);
  node.addEventListener('click', claim, true);
  globalThis.addEventListener?.('offline', policyChanged);
  connection?.addEventListener?.('change', policyChanged);
  return {
    update(next) {
      const nextIdentity = JSON.stringify(next);
      if (identity === nextIdentity) return;
      cancelPlayIntent(record);
      record = null; item = next; identity = nextIdentity;
      if (hovering || focused) start(focused ? 0 : 100);
    },
    destroy() {
      cancelPlayIntent(record);
      node.removeEventListener('pointerenter', enter);
      node.removeEventListener('pointerleave', leave);
      node.removeEventListener('focusin', focus);
      node.removeEventListener('focusout', blur);
      node.removeEventListener('click', claim, true);
      globalThis.removeEventListener?.('offline', policyChanged);
      connection?.removeEventListener?.('change', policyChanged);
    }
  };
}
