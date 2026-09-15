import { playbackSetupProgress, readPlaybackSetup } from './playback-setup.js';

// Each source owns its converter. Segment retries reuse that source's completed files.
export function playbackSource(video, initial, loadHls = () => import('hls.js')) {
  let key, dispose = () => {};
  function update(options) {
    const nextKey = `${options.url}:${options.hlsUrl}:${options.start}`;
    if (key === nextKey) return;
    key = nextKey; dispose(false);
    let closed = false, hls, sessionUrl, heartbeat, buffered = false;
    const controller = new AbortController();
    const post = path => fetch(path, { method: 'POST', keepalive: true }).catch(() => {});
    const stop = (resetMedia = true) => {
      if (closed) return;
      closed = true; controller.abort(); clearInterval(heartbeat);
      hls?.destroy();
      // Keep the established media element intact while replacing an episode
      // or seek source. An explicit load() here discards its autoplay context
      // and can make the next episode require another user gesture.
      if (resetMedia) { video.removeAttribute('src'); video.load(); }
      if (sessionUrl) void post(`${sessionUrl}/stop`);
      window.removeEventListener('pagehide', stop);
    };
    dispose = stop;
    window.addEventListener('pagehide', stop);
    options.onProgress?.(options.hlsUrl ? playbackSetupProgress(0) : null);
    if (!options.hlsUrl) { video.src = options.url; return; }
    // Resolve failures as data until the session response can be cleaned up.
    const library = Promise.resolve().then(loadHls).then(value => ({ value }), error => ({ error }));
    void (async () => {
      const response = await fetch(options.hlsUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify({ start: options.start }), signal: controller.signal });
      const session = await readPlaybackSetup(response, progress => { if (!closed) options.onProgress?.(progress); });
      if (!response.ok) throw Object.assign(new Error(session.error || 'Unable to prepare playback.'), { code: session.code });
      sessionUrl = session.sessionUrl;
      if (closed) { void post(`${sessionUrl}/stop`); return; }
      if (Number.isFinite(session.duration) && session.duration > 0) options.onDuration?.(session.duration);
      heartbeat = setInterval(() => void post(`${sessionUrl}/heartbeat`), 15000);
      const loaded = await library;
      if (closed) return;
      if (loaded.error) throw loaded.error;
      const { default: Hls } = loaded.value;
      // Prefer MSE: Chromium may advertise native HLS yet reject its segments.
      if (!Hls.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = session.playlistUrl; return; }
        throw new Error('This browser cannot play segmented video.');
      }
      hls = new Hls({ startPosition: 0, backBufferLength: 30, maxBufferLength: 30, maxMaxBufferLength: 60, maxLiveSyncPlaybackRate: 1 });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || closed) return;
        const httpStatus = Number(data.response?.code || data.networkDetails?.status) || null;
        const status = httpStatus ? ` (HTTP ${httpStatus})` : '';
        options.onError(`Segmented playback failed: ${data.details}${status}`, {
          hlsDetails: data.details, httpStatus, sessionUrl
        });
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => { if (!closed && !buffered) { buffered = true; options.onProgress?.(playbackSetupProgress(3)); } });
      hls.attachMedia(video);
      hls.loadSource(session.playlistUrl);
    })().catch(error => { if (!closed) options.onError(error.message, { code: error.code }); });
  }
  update(initial);
  return { update, destroy: () => dispose() };
}
