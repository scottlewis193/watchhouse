import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePoster } from '../src/lib/poster-preparation.js';

test('poster warming is intent-driven, ignores touch scrolling and follows reused cards', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  const requests = [];
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return {}; };
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
