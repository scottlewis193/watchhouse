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
  const video = { canPlayType: () => 'probably', removeAttribute() {}, load() {} };
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
    assert.ok(requests.some(request => request.url === '/session/1/stop'));
    listeners.get('pagehide')();
    assert.equal(instances[1].destroyed, true);
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
  const source = playbackSource({ removeAttribute() {}, load() {} }, { hlsUrl: '/hls', start: 0, onError: assert.fail }, () => assert.fail('Cancelled playback must not attach HLS'));
  try {
    source.destroy();
    assert.equal(requests[0].options.signal.aborted, true);
    deliver({ ok: true, json: async () => ({ sessionUrl: '/late-session', playlistUrl: '/late.m3u8' }) });
    await setImmediate();
    assert.ok(requests.some(request => request.url === '/late-session/stop'));
  } finally { source.destroy(); globalThis.window = oldWindow; }
});
