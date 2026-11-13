import { playbackSetupProgress, readPlaybackSetup } from './playback-setup.js';

// Each attached source owns playback; normal detach retains its validated converter.
export function playbackSource(video, initial, loadHls = () => import('hls.js')) {
  let key, excludedSessionUrl, dispose = () => {};
  function update(options) {
    const nextKey = `${options.active}:${options.url}:${options.hlsUrl}:${options.start}:${options.attempt}:${options.audioTrack}:${options.frameInterpolation}:${options.preparedSession?.sessionUrl || ''}`;
    if (key === nextKey) return;
    key = nextKey; dispose(false);
    if (options.active === false) { video.pause(); return; }
    let closed = false, failed = false, hls, sessionUrl, heartbeat, buffered = false, localRecoveries = 0, recoveryPending = false, networkRecoveryPending = false, recoveryTimer, setupTimer;
    const controller = new AbortController();
    const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
    const waitForOnline = () => offline() ? new Promise(resolve => {
      const done = () => { window.removeEventListener('online', done); controller.signal.removeEventListener('abort', done); resolve(); };
      window.addEventListener('online', done);
      controller.signal.addEventListener('abort', done, { once: true });
      if (!offline() || controller.signal.aborted) done();
    }) : Promise.resolve();
    const armSetupTimeout = () => {
      clearTimeout(setupTimer);
      setupTimer = setTimeout(() => { if (!closed && !offline()) { options.onError('Playback preparation timed out. Try again.', { code: 'PLAYBACK_TIMEOUT' }); stop(); } }, 330000);
    };
    const resumeNetwork = () => {
      if (!closed && !sessionUrl && setupTimer) armSetupTimeout();
      if (closed || !networkRecoveryPending || offline() || !hls) return;
      networkRecoveryPending = false;
      clearTimeout(recoveryTimer);
      options.onEvent?.('hls-recovery', { type: 'network', reconnect: true });
      hls.startLoad(video.currentTime);
    };
    window.addEventListener('online', resumeNetwork);
    const post = path => fetch(path, { method: 'POST', keepalive: true }).catch(() => {});
    const failSource = (message, evidence) => {
      if (closed || failed) return;
      failed = true;
      clearTimeout(recoveryTimer); clearInterval(heartbeat);
      if (sessionUrl) {
        excludedSessionUrl = sessionUrl;
        void post(`${sessionUrl}/stop?discard=1`);
      }
      options.onError(message, evidence);
    };
    const stop = (resetMedia = true) => {
      if (closed) return;
      closed = true; controller.abort(); clearInterval(heartbeat); clearTimeout(recoveryTimer); clearTimeout(setupTimer);
      hls?.destroy();
      // Keep the established media element intact while replacing an episode
      // or seek source. An explicit load() here discards its autoplay context
      // and can make the next episode require another user gesture.
      if (resetMedia) { video.removeAttribute('src'); video.load(); }
      if (sessionUrl) void post(`${sessionUrl}/stop${failed ? '?discard=1' : ''}`);
      window.removeEventListener('pagehide', stop);
      window.removeEventListener('online', resumeNetwork);
    };
    dispose = stop;
    window.addEventListener('pagehide', stop);
    options.onEvent?.('source-request', { start: options.start });
    options.onProgress?.(options.hlsUrl ? playbackSetupProgress(0) : null);
    if (!options.hlsUrl) { video.src = options.url; return; }
    // Resolve failures as data until the session response can be cleaned up.
    const library = Promise.resolve().then(loadHls).then(value => ({ value }), error => ({ error }));
    armSetupTimeout();
    void (async () => {
      let session = options.preparedSession;
      while (!session && !closed) {
        if (offline()) await waitForOnline();
        if (closed) return;
        try {
          const response = await fetch(options.hlsUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify({ start: options.start, audioTrack: options.audioTrack, frameInterpolation: options.frameInterpolation, excludeSessionUrl: options.excludeSessionUrl || excludedSessionUrl }), signal: controller.signal });
          session = await readPlaybackSetup(response, progress => { if (!closed) options.onProgress?.(progress); });
          if (!response.ok) throw Object.assign(new Error(session.error || 'Unable to prepare playback.'), { code: session.code, terminal: true });
        } catch (error) {
          if (!offline() || closed || error.terminal) throw error;
          session = null;
        }
      }
      if (closed) { if (session?.sessionUrl) void post(`${session.sessionUrl}/stop`); return; }
      if (options.preparedSession) options.onProgress?.(playbackSetupProgress(2));
      clearTimeout(setupTimer);
      sessionUrl = session.sessionUrl;
      if (closed) { void post(`${sessionUrl}/stop`); return; }
      options.onTracks?.({ tracks: session.tracks || [], selectedAudioTrack: session.selectedAudioTrack, captionsAvailable: session.captionsAvailable });
      if (Number.isFinite(session.duration) && session.duration > 0) options.onDuration?.(session.duration);
      options.onSession?.(session);
      const position = Number.isFinite(session.position) ? Math.max(0, session.position) : 0;
      heartbeat = setInterval(() => void fetch(`${sessionUrl}/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: video.paused, position: video.currentTime }), signal: controller.signal }).catch(() => {}), 5000);
      const loaded = await library;
      if (closed) return;
      if (loaded.error) throw loaded.error;
      const { default: Hls } = loaded.value;
      // Prefer MSE: Chromium may advertise native HLS yet reject its segments.
      if (!Hls.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.addEventListener?.('error', () => failSource('Segmented playback encountered a browser media error.', { sessionUrl }), { signal: controller.signal });
          video.addEventListener?.('loadedmetadata', () => { if (!closed) video.currentTime = position; }, { once: true, signal: controller.signal });
          video.src = session.playlistUrl;
          return;
        }
        throw new Error('This browser cannot play segmented video.');
      }
      hls = new Hls({ ...playbackBufferConfig(typeof navigator === 'undefined' ? {} : navigator), startPosition: position });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (closed || failed) return;
        const httpStatus = Number(data.response?.code || data.networkDetails?.status) || null;
        const evidence = { hlsDetails: data.details, httpStatus, sessionUrl };
        if (data.type) evidence.hlsType = data.type;
        options.onEvent?.('hls-error', { ...evidence, fatal: Boolean(data.fatal) });
        if (!data.fatal || recoveryPending) return;
        if (data.type === Hls.ErrorTypes?.NETWORK_ERROR && offline()) {
          networkRecoveryPending = true;
          clearTimeout(recoveryTimer);
          return;
        }
        const fail = () => failSource(`Segmented playback failed: ${data.details}${httpStatus ? ` (HTTP ${httpStatus})` : ''}`, evidence);
        recoveryPending = true;
        void (async () => {
          try {
            const response = await fetch(`${sessionUrl}/status`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
            const health = await response.json();
            if (closed) return;
            if (response.ok && health.sourceRejected) {
              failSource('This release has missing or invalid video data. Trying another source.', { ...evidence, code: 'SOURCE_REJECTED' });
              return;
            }
            if (!response.ok || health.failed || health.closed) { fail(); return; }
            if (!data.type || localRecoveries >= 2 || httpStatus && ![408, 429, 500, 502, 503, 504].includes(httpStatus)) { fail(); return; }
            localRecoveries++;
            options.onEvent?.('hls-recovery', { type: data.type, attempt: localRecoveries });
            if (data.type === Hls.ErrorTypes?.NETWORK_ERROR) hls.startLoad(video.currentTime);
            else if (data.type === Hls.ErrorTypes?.MEDIA_ERROR) hls.recoverMediaError();
            else { fail(); return; }
            clearTimeout(recoveryTimer); recoveryTimer = setTimeout(() => { if (offline() && data.type === Hls.ErrorTypes?.NETWORK_ERROR) networkRecoveryPending = true; else fail(); }, 10000);
          } catch { if (offline() && data.type === Hls.ErrorTypes?.NETWORK_ERROR) networkRecoveryPending = true; else fail(); }
          finally { recoveryPending = false; }
        })();
      });
      if (Hls.Events.FRAG_LOADED) hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        if (!closed) options.onEvent?.('hls-fragment', { sequence: data.frag?.sn, bytes: data.frag?.stats?.total, loadMs: data.frag?.stats?.loading ? data.frag.stats.loading.end - data.frag.stats.loading.start : null });
      });
      const recovered = () => { clearTimeout(recoveryTimer); };
      video.addEventListener?.('playing', recovered, { signal: controller.signal });
      hls.on(Hls.Events.FRAG_BUFFERED, () => { if (!closed && !buffered) { buffered = true; options.onProgress?.(playbackSetupProgress(3)); } });
      hls.attachMedia(video);
      hls.loadSource(session.playlistUrl);
    })().catch(error => { clearTimeout(setupTimer); failSource(error.message, { code: error.code, ...(sessionUrl ? { sessionUrl } : {}) }); });
  }
  update(initial);
  return { update, destroy: () => dispose() };
}

export function playbackBufferConfig(environment = {}) {
  const constrained = Boolean(environment.connection?.saveData) || Number(environment.deviceMemory) > 0 && Number(environment.deviceMemory) <= 2;
  return { startPosition: 0, backBufferLength: constrained ? 15 : 30, maxBufferLength: constrained ? 15 : 30, maxMaxBufferLength: constrained ? 30 : 60, maxBufferSize: (constrained ? 30 : 60) * 1000 * 1000, maxLiveSyncPlaybackRate: 1 };
}
