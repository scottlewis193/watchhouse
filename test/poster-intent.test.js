import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePlayIntent, preparePoster, preparePosterNavigation, prewarmPlayback, shouldPrewarmResume } from '../src/lib/poster-preparation.js';

test('title details only prewarm a saved resume with automatic online playback', () => {
  const eligible = { position: 120, online: true };
  assert.equal(shouldPrewarmResume(eligible), true);
  for (const blocked of [
    { position: 0, online: true },
    { ...eligible, online: false },
    { ...eligible, saveData: true },
    { ...eligible, offlineMode: true },
    { ...eligible, manualReleaseSelection: true },
    { ...eligible, shouldStartImmediately: true }
  ]) assert.equal(shouldPrewarmResume(blocked), false);
});

test('home playback starts preparation without delaying navigation for its response', async () => {
  const order = [];
  let release;
  const preparing = new Promise(resolve => { release = resolve; });
  const navigation = preparePosterNavigation(
    { type: 'movie', id: 671 },
    '/watch/movie/671?play=1&resume=1',
    href => { order.push(['navigate', href]); },
    item => { order.push(['prepare', item.id]); return preparing; }
  );
  await Promise.resolve();
  assert.deepEqual(order, [['prepare', 671], ['navigate', '/watch/movie/671?play=1&resume=1']]);
  await navigation;
  release();
});

test('poster warming is intent-driven, ignores touch scrolling and follows reused cards', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  const requests = [];
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ prepared: true }) }; };
  const node = new EventTarget(), first = { type: 'tv', id: 1, season: 1, episode: 1 };
  const action = preparePoster(node, first);
  const event = type => Object.assign(new Event('pointerenter'), { pointerType: type });
  try {
    node.dispatchEvent(event('touch'));
    await new Promise(resolve => setTimeout(resolve, 370));
    assert.equal(requests.length, 0);
    node.dispatchEvent(event('mouse'));
    action.update({ ...first, episode: 2 });
    node.dispatchEvent(new Event('focusin'));
    await new Promise(resolve => setTimeout(resolve, 370));
    assert.deepEqual(requests, [{ type: 'tv', id: 1, season: 1, episode: 2 }]);
    action.update(null); node.dispatchEvent(event('mouse'));
    await new Promise(resolve => setTimeout(resolve, 370));
    assert.equal(requests.length, 1, 'ordinary catalogue cards must never prewarm');
  } finally {
    action.destroy(); globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
  }
});

test('concurrent preparation shares one request and rejected responses allow retry', async () => {
  const item = { type: 'tv', id: 91, season: 1, episode: 2 };
  const requests = [];
  let finish;
  const fetcher = (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Promise(resolve => { finish = resolve; });
  };
  const first = prewarmPlayback(item, { fetcher });
  const duplicate = prewarmPlayback({ ...item }, { fetcher });
  assert.equal(requests.length, 1);
  finish({ ok: true, json: async () => ({ prepared: false }) });
  await assert.rejects(first);
  await assert.rejects(duplicate);
  const retry = prewarmPlayback(item, { fetcher });
  assert.equal(requests.length, 2);
  finish({ ok: true, json: async () => ({ prepared: true }) });
  assert.deepEqual(await retry, { prepared: true });
});

test('HTTP and network errors do not count as accepted preparation', async () => {
  const item = { type: 'movie', id: 92 };
  let calls = 0;
  const fetcher = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 503 };
    if (calls === 2) throw new Error('Network unavailable');
    return { ok: true, json: async () => ({ prepared: true }) };
  };
  await assert.rejects(prewarmPlayback(item, { fetcher }), /503/);
  await assert.rejects(prewarmPlayback(item, { fetcher }), /Network unavailable/);
  assert.deepEqual(await prewarmPlayback(item, { fetcher }), { prepared: true });
  assert.equal(calls, 3);
});

test('poster retries declined preparation and rechecks data policy after debounce', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), originalFetch = globalThis.fetch;
  const connection = { saveData: false };
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, connection }, configurable: true });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ prepared: calls > 1 }) };
  };
  const node = new EventTarget(), action = preparePoster(node, { type: 'movie', id: 93 });
  try {
    node.dispatchEvent(new Event('focusin'));
    await new Promise(resolve => setTimeout(resolve, 370));
    assert.equal(calls, 1);
    node.dispatchEvent(new Event('focusin'));
    connection.saveData = true;
    await new Promise(resolve => setTimeout(resolve, 370));
    assert.equal(calls, 1, 'data saver enabled during debounce must prevent work');
    connection.saveData = false;
    node.dispatchEvent(new Event('focusin'));
    await new Promise(resolve => setTimeout(resolve, 370));
    assert.equal(calls, 2);
  } finally {
    action.destroy(); globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
  }
});

test('navigation continues when preparation rejects or throws synchronously', async () => {
  for (const prepare of [() => Promise.reject(new Error('Unavailable')), () => { throw new Error('Unavailable'); }]) {
    const navigated = [];
    await preparePosterNavigation({ id: 94, type: 'movie' }, '/watch/movie/94', href => navigated.push(href), prepare);
    assert.deepEqual(navigated, ['/watch/movie/94']);
  }
});

test('direct prewarm requests respect offline and data saver policy', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let calls = 0;
  const fetcher = async () => { calls++; return { ok: true, json: async () => ({ prepared: true }) }; };
  try {
    for (const navigator of [{ onLine: false }, { onLine: true, connection: { saveData: true } }]) {
      Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true });
      await assert.rejects(prewarmPlayback({ type: 'movie', id: 95 }, { fetcher }), /network policy/);
    }
    assert.equal(calls, 0);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
  }
});

test('a reused card ignores a previous item failure while its replacement is prepared', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  const requests = [];
  let rejectFirst;
  globalThis.fetch = (_url, options) => {
    const item = JSON.parse(options.body);
    requests.push(item);
    if (item.id === 96) return new Promise((_resolve, reject) => { rejectFirst = reject; });
    return Promise.resolve({ ok: true, json: async () => ({ prepared: true }) });
  };
  const node = new EventTarget(), action = preparePoster(node, { type: 'movie', id: 96 });
  try {
    node.dispatchEvent(new Event('focusin'));
    await new Promise(resolve => setTimeout(resolve, 370));
    action.update({ type: 'movie', id: 97 });
    node.dispatchEvent(new Event('focusin'));
    await new Promise(resolve => setTimeout(resolve, 370));
    rejectFirst(new Error('Previous item failed'));
    await new Promise(resolve => setImmediate(resolve));
    action.update({ type: 'movie', id: 97 });
    node.dispatchEvent(new Event('focusin'));
    await new Promise(resolve => setTimeout(resolve, 370));
    assert.deepEqual(requests.map(item => item.id), [96, 97]);
  } finally {
    action.destroy(); globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
  }
});

function playIntentFixture(t, navigator = { onLine: true }) {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [], actions = [];
  globalThis.fetch = async (_url, options) => {
    requests.push({ method: options.method, body: JSON.parse(options.body), signal: options.signal });
    return { ok: true, json: async () => ({ prepared: true }) };
  };
  const create = item => {
    const node = new EventTarget(), action = preparePlayIntent(node, item);
    actions.push(action);
    return { node, action };
  };
  t.after(() => {
    for (const action of actions) action.destroy();
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
  });
  return { create, requests };
}

const playPointer = (type = 'mouse') => Object.assign(new Event('pointerenter'), { pointerType: type });
const playClick = options => Object.assign(new Event('click'), { button: 0, ...options });
const settlePreparation = () => new Promise(resolve => setImmediate(resolve));

test('Play-control pointer intent dispatches before a quick click while rendering and touch scrolling stay idle', async t => {
  const { create, requests } = playIntentFixture(t);
  const movie = { type: 'movie', id: 201, title: 'A New Film', year: '2025', durationHint: 6600, poster: '/film.jpg' };
  const { node } = create(movie);
  t.mock.timers.tick(1000);
  node.dispatchEvent(playPointer('touch'));
  t.mock.timers.tick(1000);
  assert.equal(requests.length, 0, 'rendering and touch scrolling cannot prepare a title');
  node.dispatchEvent(playPointer());
  t.mock.timers.tick(50);
  assert.equal(requests.length, 0, 'a passing pointer still has time to leave without provider work');
  t.mock.timers.tick(100);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, { ...movie, intent: true, requestId: requests[0].body.requestId });
  assert.equal(typeof requests[0].body.requestId, 'string');
  assert.ok(requests[0].body.requestId.length > 0);
  await settlePreparation();
});

test('keyboard focus immediately advances pending Play intent without repeated events delaying or duplicating dispatch', async t => {
  const { create, requests } = playIntentFixture(t);
  const { node } = create({ type: 'movie', id: 214, title: 'Keyboard Film' });
  node.dispatchEvent(playPointer());
  t.mock.timers.tick(50);
  node.dispatchEvent(new Event('focusin'));
  node.dispatchEvent(playPointer());
  node.dispatchEvent(new Event('focusin'));
  t.mock.timers.tick(0);
  assert.equal(requests.length, 1, 'focus must not wait out the pointer debounce');
  assert.equal(requests[0].body.id, 214);
  t.mock.timers.tick(1000);
  assert.equal(requests.length, 1, 'the old pointer timer must not start a second request');
  await settlePreparation();
});

test('leaving a briefly crossed Play control cancels dispatch before provider work starts', t => {
  const { create, requests } = playIntentFixture(t);
  const { node } = create({ type: 'movie', id: 215, title: 'Passing Film' });
  node.dispatchEvent(playPointer());
  t.mock.timers.tick(50);
  node.dispatchEvent(new Event('pointerleave'));
  t.mock.timers.tick(1000);
  assert.equal(requests.length, 0);
});

test('abandoning a Play hover aborts its request and cancels its unclaimed server token', async t => {
  const { create, requests } = playIntentFixture(t);
  const { node, action } = create({ type: 'movie', id: 202, title: 'Abandoned Film' });
  node.dispatchEvent(playPointer());
  t.mock.timers.tick(350);
  const request = requests[0];
  node.dispatchEvent(new Event('pointerleave'));
  assert.equal(request.signal.aborted, true);
  assert.deepEqual(requests[1], { method: 'DELETE', body: { requestId: request.body.requestId }, signal: undefined });
  action.destroy();
  assert.equal(requests.length, 2, 'cleanup must not cancel the same token twice');
  await settlePreparation();
});

test('moving between Play controls cancels both pending debounce and active previous-title intent', async t => {
  const { create, requests } = playIntentFixture(t);
  const first = create({ type: 'movie', id: 203, title: 'First' });
  const second = create({ type: 'movie', id: 204, title: 'Second' });
  first.node.dispatchEvent(playPointer());
  t.mock.timers.tick(50);
  second.node.dispatchEvent(new Event('focusin'));
  t.mock.timers.tick(350);
  assert.deepEqual(requests.map(request => [request.method, request.body.id]), [['POST', 204]]);
  first.node.dispatchEvent(new Event('focusin'));
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].method, 'DELETE');
  t.mock.timers.tick(350);
  assert.deepEqual(requests.filter(request => request.method === 'POST').map(request => request.body.id), [204, 203]);
  await settlePreparation();
});

test('Play click hands its preparation to navigation without aborting it during blur or destruction', async t => {
  const { create, requests } = playIntentFixture(t);
  const { node, action } = create({ type: 'movie', id: 205, title: 'Clicked Film' });
  node.dispatchEvent(new Event('focusin'));
  t.mock.timers.tick(350);
  node.dispatchEvent(playClick());
  node.dispatchEvent(new Event('focusout'));
  action.destroy();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal.aborted, false);
  await settlePreparation();
});

test('clicking before queued Play intent dispatch leaves foreground navigation as the sole owner', t => {
  const { create, requests } = playIntentFixture(t);
  const { node, action } = create({ type: 'movie', id: 216, title: 'Immediate Keyboard Play' });
  node.dispatchEvent(new Event('focusin'));
  node.dispatchEvent(playClick());
  node.dispatchEvent(new Event('focusout'));
  action.destroy();
  t.mock.timers.tick(1000);
  assert.equal(requests.length, 0, 'a cancelled focus timer must not dispatch or abandon a foreground Play');
});

test('an immediate Play click cancels a different title but does not wait for a hover debounce', async t => {
  const { create, requests } = playIntentFixture(t);
  const previous = create({ type: 'movie', id: 206, title: 'Previous Film' });
  const selected = create({ type: 'movie', id: 207, title: 'Selected Film' });
  previous.node.dispatchEvent(playPointer());
  t.mock.timers.tick(350);
  selected.node.dispatchEvent(playClick());
  t.mock.timers.tick(350);
  assert.deepEqual(requests.map(request => request.method), ['POST', 'DELETE']);
  assert.equal(requests[0].signal.aborted, true);
  await settlePreparation();
});

test('new-title preparation requires a specific episode and honors all client policy guards', async t => {
  const connection = { saveData: false }, navigator = { onLine: true, connection };
  const { create, requests } = playIntentFixture(t, navigator);
  for (const item of [
    null,
    { type: 'tv', id: 208, title: 'Series Only' },
    { type: 'tv', id: 208, title: 'Season Only', season: 1 },
    { type: 'tv', id: 208, title: 'Invalid Episode', season: 1, episode: 0 },
    { type: 'movie', id: 208, title: 'Manual Film', manualReleaseSelection: true },
    { type: 'movie', id: 208, title: 'Offline Film', offlineMode: true },
    { type: 'movie', id: 208, title: 'Downloaded Film', downloaded: true },
    { type: 'movie', id: 208, title: 'Saved Resume', position: 30 }
  ]) {
    create(item).node.dispatchEvent(new Event('focusin'));
    t.mock.timers.tick(350);
  }
  assert.equal(requests.length, 0);
  const { node } = create({ type: 'tv', id: 208, title: 'Selected Episode', season: 2, episode: 3, episodeTitle: 'Third', durationHint: 2700 });
  node.dispatchEvent(new Event('focusin'));
  connection.saveData = true;
  t.mock.timers.tick(350);
  assert.equal(requests.length, 0, 'policy changes during debounce must prevent work');
  connection.saveData = false; navigator.onLine = false;
  node.dispatchEvent(new Event('focusin'));
  t.mock.timers.tick(350);
  assert.equal(requests.length, 0);
  navigator.onLine = true;
  node.dispatchEvent(new Event('focusin'));
  t.mock.timers.tick(350);
  assert.equal(requests[0].body.episode, 3);
  await settlePreparation();
});

test('a focused reused Play control cancels old metadata and prepares only its current episode', async t => {
  const { create, requests } = playIntentFixture(t);
  const item = { type: 'tv', id: 209, title: 'Series', season: 1, episode: 1 };
  const { node, action } = create(item);
  node.dispatchEvent(new Event('focusin'));
  t.mock.timers.tick(350);
  action.update({ ...item, episode: 2 });
  assert.equal(requests[0].signal.aborted, true);
  t.mock.timers.tick(350);
  assert.deepEqual(requests.filter(request => request.method === 'POST').map(request => request.body.episode), [1, 2]);
  await settlePreparation();
});

test('new-title helper passes metadata and AbortSignal without changing saved-resume request bodies', async () => {
  const item = { type: 'movie', id: 210, title: 'Metadata Film', year: '2023', durationHint: 7200 };
  const requests = [], controller = new AbortController();
  const fetcher = (_url, options) => {
    requests.push({ body: JSON.parse(options.body), signal: options.signal });
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  const intent = prewarmPlayback(item, { fetcher, intent: true, requestId: 'metadata-hover', signal: controller.signal });
  const saved = prewarmPlayback(item, { fetcher, signal: controller.signal });
  assert.equal(requests.length, 2, 'intent ownership must not deduplicate with a saved resume');
  assert.deepEqual(requests[0].body, { ...item, intent: true, requestId: 'metadata-hover' });
  assert.deepEqual(requests[1].body, { id: 210, type: 'movie' });
  controller.abort(new Error('Abandoned'));
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, true);
  await assert.rejects(intent, /Abandoned/);
  await assert.rejects(saved, /Abandoned/);
});

test('keyboard focus keeps accepted Play intent alive after the mouse leaves until focus is abandoned', async t => {
  const { create, requests } = playIntentFixture(t);
  const { node } = create({ type: 'movie', id: 211, title: 'Focused Film' });
  node.dispatchEvent(playPointer());
  node.dispatchEvent(new Event('focusin'));
  t.mock.timers.tick(350);
  await settlePreparation();
  node.dispatchEvent(new Event('pointerleave'));
  assert.equal(requests.length, 1, 'keyboard intent survives pointer departure');
  node.dispatchEvent(new Event('focusout'));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body, { requestId: requests[0].body.requestId });
});

test('data saver enabled while a Play intent is active cancels provider preparation', async t => {
  const connection = Object.assign(new EventTarget(), { saveData: false });
  const { create, requests } = playIntentFixture(t, { onLine: true, connection });
  const { node } = create({ type: 'movie', id: 212, title: 'Metered Film' });
  node.dispatchEvent(new Event('focusin'));
  t.mock.timers.tick(350);
  await settlePreparation();
  connection.saveData = true;
  connection.dispatchEvent(new Event('change'));
  assert.deepEqual(requests.map(request => request.method), ['POST', 'DELETE']);
  node.dispatchEvent(new Event('focusin'));
  t.mock.timers.tick(350);
  assert.equal(requests.length, 2);
});

test('a declined new-title preparation is cancellable and a later explicit intent can retry', async t => {
  const { create, requests } = playIntentFixture(t);
  const acceptingFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (url, options) => {
    const response = await acceptingFetch(url, options);
    if (options.method === 'POST' && ++posts === 1) return { ok: true, json: async () => ({ prepared: false }) };
    return response;
  };
  const { node } = create({ type: 'movie', id: 213, title: 'Retry Film' });
  node.dispatchEvent(new Event('focusin'));
  t.mock.timers.tick(350);
  await settlePreparation();
  assert.deepEqual(requests.map(request => request.method), ['POST', 'DELETE']);
  node.dispatchEvent(new Event('focusin'));
  t.mock.timers.tick(350);
  await settlePreparation();
  assert.equal(posts, 2);
  assert.notEqual(requests[0].body.requestId, requests[2].body.requestId);
});
