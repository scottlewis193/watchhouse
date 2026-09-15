import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { playbackSource } from '../src/lib/hls-playback.js';

test('prefers MSE over advertised native HLS and releases a source when seeking or leaving', async t => {
  const requests = [], instances = [], listeners = new Map();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ sessionUrl: `/session/${requests.length}`, playlistUrl: '/playlist.m3u8' }) };
  });
  const oldWindow = globalThis.window;
  globalThis.window = { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
  class Hls {
    static isSupported = () => true;
    static Events = { ERROR: 'error' };
    constructor() { instances.push(this); }
    on() {}
    attachMedia(video) { this.video = video; }
    loadSource(url) { this.url = url; }
    destroy() { this.destroyed = true; }
  }
  let resets = 0;
  const video = { canPlayType: () => 'probably', removeAttribute() {}, load() { resets++; } };
  const options = { url: '/stream', hlsUrl: '/hls', start: 0, onError: error => { throw new Error(error); } };
  const source = playbackSource(video, options, async () => ({ default: Hls }));
  try {
    await setImmediate();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].url, '/playlist.m3u8');
    assert.equal(video.src, undefined, 'must not select unreliable native HLS when MSE is supported');
    source.update({ ...options });
    await setImmediate();
    assert.equal(instances.length, 1, 'diagnostic polling must not recreate playback');
    source.update({ ...options, start: 120 });
    await setImmediate();
    assert.equal(instances[0].destroyed, true);
    assert.equal(instances.length, 2);
    assert.equal(resets, 0, 'replacing a source must preserve the established media element for autoplay');
    assert.ok(requests.some(request => request.url === '/session/1/stop'));
    listeners.get('pagehide')();
    assert.equal(instances[1].destroyed, true);
    assert.equal(resets, 1, 'leaving playback must still reset and release the media element');
    assert.equal(listeners.size, 0);
  } finally { source.destroy(); globalThis.window = oldWindow; }
});

test('leaving during startup releases a session even if its response arrives after cancellation', async t => {
  const requests = [];
  let deliver;
  const response = new Promise(resolve => { deliver = resolve; });
  t.mock.method(globalThis, 'fetch', (url, options) => {
    requests.push({ url, options });
    return url === '/hls' ? response : Promise.resolve({ ok: true });
  });
  const oldWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const source = playbackSource({ removeAttribute() {}, load() {} }, { hlsUrl: '/hls', start: 0, onError: assert.fail }, async () => ({ default: class { constructor() { assert.fail('Cancelled playback must not attach HLS'); } } }));
  try {
    source.destroy();
    assert.equal(requests[0].options.signal.aborted, true);
    deliver({ ok: true, json: async () => ({ sessionUrl: '/late-session', playlistUrl: '/late.m3u8' }) });
    await setImmediate();
    assert.ok(requests.some(request => request.url === '/late-session/stop'));
  } finally { source.destroy(); globalThis.window = oldWindow; }
});

test('a terminal source rejection reaches recovery with its error code', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, json: async () => ({ error: 'No usable source', code: 'SOURCE_UNAVAILABLE' }) }));
  const oldWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const errors = [];
  const source = playbackSource({ removeAttribute() {}, load() {} }, { hlsUrl: '/hls', start: 27, onError: (...args) => errors.push(args) }, async () => ({ default: class { constructor() { assert.fail('Rejected sources must not create a player'); } } }));
  try {
    await setImmediate();
    assert.deepEqual(errors, [['No usable source', { code: 'SOURCE_UNAVAILABLE' }]]);
  } finally { source.destroy(); globalThis.window = oldWindow; }
});


test('loads the player library while the server is still preparing playback', async t => {
  let deliver, loaded = false;
  const pending = new Promise(resolve => { deliver = resolve; });
  t.mock.method(globalThis, 'fetch', url => url === '/hls' ? pending : Promise.resolve({ ok: true }));
  const oldWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const source = playbackSource({ removeAttribute() {}, load() {} },
    { hlsUrl: '/hls', start: 0, onError: assert.fail },
    async () => { loaded = true; return {}; });
  try {
    await setImmediate();
    assert.equal(loaded, true, 'library download must overlap server preparation');
  } finally {
    source.destroy();
    deliver({ ok: true, json: async () => ({ sessionUrl: '/session', playlistUrl: '/playlist' }) });
    await setImmediate();
    globalThis.window = oldWindow;
  }
});

test('delivers the full source duration before attaching a growing HLS stream', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ sessionUrl: '/duration-session', playlistUrl: '/playlist', duration: 1407.018 }) }));
  const oldWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  let duration;
  class Hls {
    static isSupported = () => true;
    static Events = {};
    on() {}
    attachMedia() { assert.equal(duration, 1407.018); }
    loadSource() {}
    destroy() {}
  }
  const source = playbackSource({ removeAttribute() {}, load() {} },
    { hlsUrl: '/hls', start: 1200, onError: assert.fail, onDuration: value => { duration = value; } },
    async () => ({ default: Hls }));
  try { await setImmediate(); assert.equal(duration, 1407.018); }
  finally { source.destroy(); globalThis.window = oldWindow; }
});

test('fatal playlist errors retain HTTP status and session identity for diagnosis', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ sessionUrl: '/session/failed', playlistUrl: '/playlist.m3u8' }) }));
  const oldWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const errors = []; let errorHandler;
  class Hls {
    static isSupported = () => true;
    static Events = { ERROR: 'error', FRAG_BUFFERED: 'buffered' };
    on(event, callback) { if (event === 'error') errorHandler = callback; }
    attachMedia() {} loadSource() {} destroy() {}
  }
  const source = playbackSource({ removeAttribute() {}, load() {} }, { hlsUrl: '/hls', start: 0, onError: (...args) => errors.push(args) }, async () => ({ default: Hls }));
  try {
    await setImmediate();
    errorHandler(null, { fatal: false, details: 'levelLoadError', response: { code: 500 } });
    assert.equal(errors.length, 0);
    errorHandler(null, { fatal: true, details: 'levelLoadError', response: { code: 500 } });
    assert.deepEqual(errors[0], ['Segmented playback failed: levelLoadError (HTTP 500)', { hlsDetails: 'levelLoadError', httpStatus: 500, sessionUrl: '/session/failed' }]);
    source.destroy();
    errorHandler(null, { fatal: true, details: 'levelLoadError' });
    assert.equal(errors.length, 1);
  } finally { source.destroy(); globalThis.window = oldWindow; }
});
