import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { playbackSource } from '../src/lib/hls-playback.js';

test('reuses a checked HLS session without requesting a second conversion', async t => {
  const requests = [], progress = [];
  t.mock.method(globalThis, 'fetch', async url => { requests.push(url); return { ok: true }; });
  const oldWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  class Hls {
    static isSupported = () => true;
    static Events = {};
    on() {}
    attachMedia() {}
    loadSource(url) { assert.equal(url, '/checked/index.m3u8'); }
    destroy() {}
  }
  const video = { paused: true, currentTime: 0, removeAttribute() {}, load() {} };
  const source = playbackSource(video, { hlsUrl: '/hls', start: 0, preparedSession: { sessionUrl: '/checked', playlistUrl: '/checked/index.m3u8' }, onProgress: value => progress.push(value), onError: assert.fail }, async () => ({ default: Hls }));
  try {
    await setImmediate();
    assert.equal(requests.includes('/hls'), false);
    assert.equal(progress.at(-1).completed, 2);
  } finally { source.destroy(); globalThis.window = oldWindow; }
});

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
    await setImmediate();
    assert.deepEqual(errors[0], ['Segmented playback failed: levelLoadError (HTTP 500)', { hlsDetails: 'levelLoadError', httpStatus: 500, sessionUrl: '/session/failed' }]);
    source.destroy();
    errorHandler(null, { fatal: true, details: 'levelLoadError' });
    assert.equal(errors.length, 1);
  } finally { source.destroy(); globalThis.window = oldWindow; }
});

test('retained video pauses during episode preparation and restarts the source for a same-position retry', async t => {
  const requests = [], instances = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url);
    return { ok: true, json: async () => ({ sessionUrl: `/session/${requests.length}`, playlistUrl: '/playlist.m3u8' }) };
  });
  const oldWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  class Hls {
    static isSupported = () => true;
    static Events = { ERROR: 'error', FRAG_BUFFERED: 'buffered' };
    constructor() { instances.push(this); }
    on() {}
    attachMedia(video) { this.video = video; }
    loadSource() {}
    destroy() { this.destroyed = true; }
  }
  let pauses = 0, resets = 0;
  const video = { pause() { pauses++; }, removeAttribute() {}, load() { resets++; } };
  const options = { active: true, attempt: 0, url: '/stream/1', hlsUrl: '/hls/1', start: 0, onError: assert.fail };
  const source = playbackSource(video, options, async () => ({ default: Hls }));
  try {
    await setImmediate();
    source.update({ active: false, attempt: 0 });
    await setImmediate();
    assert.equal(pauses, 1);
    assert.equal(instances[0].destroyed, true);
    assert.equal(instances.length, 1, 'preparation must not attach an empty source');
    source.update({ ...options, url: '/stream/2', hlsUrl: '/hls/2' });
    await setImmediate();
    source.update({ ...options, url: '/stream/2', hlsUrl: '/hls/2', attempt: 1 });
    await setImmediate();
    assert.equal(instances.length, 3, 'same-position recovery must create a fresh source');
    assert.ok(instances.every(instance => instance.video === video), 'all sources use the established video element');
    assert.equal(resets, 0);
  } finally { source.destroy(); globalThis.window = oldWindow; }
});

test('fatal transient network errors reuse a healthy converter session before escalating', async t => {
  const requests=[], errors=[]; let errorHandler,loads=0;
  t.mock.method(globalThis,'fetch',async url=>{requests.push(url); return {ok:true,json:async()=>url.endsWith('/status')?{failed:false,closed:false}:{sessionUrl:'/healthy',playlistUrl:'/playlist'}};});
  const oldWindow=globalThis.window; globalThis.window={addEventListener(){},removeEventListener(){}};
  class Hls {
    static isSupported=()=>true;
    static Events={ERROR:'error',FRAG_BUFFERED:'buffered'};
    static ErrorTypes={NETWORK_ERROR:'networkError',MEDIA_ERROR:'mediaError'};
    on(event,callback){if(event==='error') errorHandler=callback;}
    attachMedia(){} loadSource(){} destroy(){} startLoad(position){assert.equal(position,12);loads++;}
  }
  const source=playbackSource({currentTime:12,removeAttribute(){},load(){}},{hlsUrl:'/hls',start:0,onError:(...args)=>errors.push(args)},async()=>({default:Hls}));
  try {
    await setImmediate();
    for(let i=0;i<3;i++){errorHandler(null,{fatal:true,type:'networkError',details:'fragLoadError',response:{code:503}});await setImmediate();}
    assert.equal(loads,2); assert.equal(errors.length,1);
    assert.equal(requests.filter(url=>url==='/hls').length,1);
  } finally {source.destroy();globalThis.window=oldWindow;}
});

test('an offline HLS failure waits for reconnection and resumes the existing session at the playhead', async t => {
  const oldWindow = globalThis.window, oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const listeners = new Map(), requests = [], errors = [], loads = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  globalThis.window = {
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); }
  };
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url);
    return { ok: true, json: async () => ({ sessionUrl: '/existing', playlistUrl: '/playlist' }) };
  });
  let errorHandler;
  class Hls {
    static isSupported = () => true;
    static Events = { ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError' };
    on(event, callback) { if (event === 'error') errorHandler = callback; }
    attachMedia() {} loadSource() {} destroy() {}
    startLoad(position) { loads.push(position); }
  }
  const video = { currentTime: 1872, paused: false, removeAttribute() {}, load() {} };
  const source = playbackSource(video, { hlsUrl: '/hls', start: 0, onError: (...args) => errors.push(args) }, async () => ({ default: Hls }));
  try {
    await setImmediate();
    globalThis.navigator.onLine = false;
    errorHandler(null, { fatal: true, type: 'networkError', details: 'fragLoadError' });
    await setImmediate();
    assert.deepEqual(errors, []);
    assert.deepEqual(loads, []);
    assert.equal(requests.includes('/existing/status'), false);
    globalThis.navigator.onLine = true;
    listeners.get('online')();
    assert.deepEqual(loads, [1872]);
    assert.equal(video.paused, false);
    assert.equal(requests.filter(url => url === '/hls').length, 1);
  } finally {
    source.destroy(); globalThis.window = oldWindow;
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator);
    else delete globalThis.navigator;
  }
});

test('playback setup retries after connectivity returns', async t => {
  const oldWindow = globalThis.window, oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const listeners = new Map(), errors = [], requests = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
  globalThis.window = {
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); }
  };
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url);
    return { ok: true, json: async () => ({ sessionUrl: '/reconnected', playlistUrl: '/playlist' }) };
  });
  let attached = false;
  class Hls {
    static isSupported = () => true;
    static Events = { ERROR: 'error' };
    on() {} attachMedia() { attached = true; } loadSource() {} destroy() {}
  }
  const source = playbackSource({ removeAttribute() {}, load() {} }, { hlsUrl: '/hls', start: 900, onError: (...args) => errors.push(args) }, async () => ({ default: Hls }));
  try {
    await setImmediate();
    assert.equal(requests.includes('/hls'), false);
    globalThis.navigator.onLine = true;
    listeners.get('online')();
    await setImmediate();
    assert.equal(attached, true);
    assert.deepEqual(errors, []);
    assert.equal(requests.filter(url => url === '/hls').length, 1);
  } finally {
    source.destroy(); globalThis.window = oldWindow;
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator);
    else delete globalThis.navigator;
  }
});

test('an interrupted setup request is retried after reconnecting', async t => {
  const oldWindow = globalThis.window, oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const listeners = new Map(), errors = [], requests = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  globalThis.window = {
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); }
  };
  let rejectFirst;
  t.mock.method(globalThis, 'fetch', url => {
    requests.push(url);
    if (url === '/hls' && requests.filter(request => request === '/hls').length === 1) return new Promise((_resolve, reject) => { rejectFirst = reject; });
    return Promise.resolve({ ok: true, json: async () => ({ sessionUrl: '/reconnected', playlistUrl: '/playlist' }) });
  });
  let attached = false;
  class Hls {
    static isSupported = () => true;
    static Events = { ERROR: 'error' };
    on() {} attachMedia() { attached = true; } loadSource() {} destroy() {}
  }
  const source = playbackSource({ removeAttribute() {}, load() {} }, { hlsUrl: '/hls', start: 900, onError: (...args) => errors.push(args) }, async () => ({ default: Hls }));
  try {
    globalThis.navigator.onLine = false;
    rejectFirst(new TypeError('Network connection lost'));
    await setImmediate();
    assert.deepEqual(errors, []);
    assert.equal(requests.filter(url => url === '/hls').length, 1);
    globalThis.navigator.onLine = true;
    listeners.get('online')();
    await setImmediate();
    assert.equal(attached, true);
    assert.equal(requests.filter(url => url === '/hls').length, 2);
  } finally {
    source.destroy(); globalThis.window = oldWindow;
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator);
    else delete globalThis.navigator;
  }
});

test('a rejected source skips local HLS retries and requests release replacement', async t => {
  const errors = []; let onError;
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, json: async () => url.endsWith('/status')
    ? { failed: true, sourceRejected: true } : { sessionUrl: '/rejected', playlistUrl: '/playlist' } }));
  const oldWindow = globalThis.window; globalThis.window = { addEventListener() {}, removeEventListener() {} };
  class Hls {
    static isSupported = () => true;
    static Events = { ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError' };
    on(event, callback) { if (event === 'error') onError = callback; }
    attachMedia() {} loadSource() {} destroy() {}
    startLoad() { assert.fail('The failed release must not be retried'); }
  }
  const source = playbackSource({ currentTime: 120, removeAttribute() {}, load() {} },
    { hlsUrl: '/hls', start: 120, onError: (...args) => errors.push(args) }, async () => ({ default: Hls }));
  try {
    await setImmediate();
    onError(null, { fatal: true, type: 'networkError', details: 'levelLoadError', response: { code: 500 } });
    await setImmediate();
    assert.equal(errors.length, 1);
    assert.equal(errors[0][1].code, 'SOURCE_REJECTED');
  } finally { source.destroy(); globalThis.window = oldWindow; }
});

test('a prepared replacement session attaches without starting a second conversion', async t => {
  const requests = [], instances = [];
  t.mock.method(globalThis, 'fetch', async url => { requests.push(url); return { ok: true }; });
  const oldWindow = globalThis.window; globalThis.window = { addEventListener() {}, removeEventListener() {} };
  class Hls {
    static isSupported = () => true;
    static Events = { ERROR: 'error', FRAG_BUFFERED: 'buffered' };
    on() {} attachMedia() {} loadSource(url) { instances.push(url); } destroy() {}
  }
  const source = playbackSource({ removeAttribute() {}, load() {} }, {
    hlsUrl: '/hls', start: 129, preparedSession: { sessionUrl: '/prepared', playlistUrl: '/prepared/index.m3u8' }, onError: assert.fail
  }, async () => ({ default: Hls }));
  try {
    await setImmediate();
    assert.deepEqual(instances, ['/prepared/index.m3u8']);
    assert.equal(requests.includes('/hls'), false);
  } finally { source.destroy(); globalThis.window = oldWindow; }
});

test('constrained buffer profiles respect data saving without altering media quality', async () => {
  const {playbackBufferConfig}=await import('../src/lib/hls-playback.js');
  assert.equal(playbackBufferConfig().maxBufferLength,30);
  assert.equal(playbackBufferConfig({connection:{saveData:true}}).maxBufferLength,15);
  assert.equal(playbackBufferConfig({deviceMemory:2}).maxMaxBufferLength,30);
});

test('interpolation opt-out recreates only the session and sends the native-frame override', async t => {
  const requests = [], instances = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({sessionUrl: '/session', playlistUrl: '/playlist'}) };
  });
  const oldWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  class Hls {
    static isSupported = () => true;
    static Events = {ERROR: 'error'};
    constructor() { instances.push(this); }
    on() {} attachMedia() {} loadSource() {} destroy() {}
  }
  const options = {hlsUrl: '/hls', start: 311, onError: assert.fail};
  const source = playbackSource({removeAttribute() {}, load() {}}, options, async () => ({default: Hls}));
  try {
    await setImmediate();
    source.update({...options, frameInterpolation: false});
    await setImmediate();
    assert.equal(instances.length, 2);
    const sessions = requests.filter(request => request.url === '/hls');
    assert.equal(JSON.parse(sessions[0].options.body).frameInterpolation, undefined);
    assert.deepEqual(JSON.parse(sessions[1].options.body), {start: 311, frameInterpolation: false});
  } finally { source.destroy(); globalThis.window = oldWindow; }
});
