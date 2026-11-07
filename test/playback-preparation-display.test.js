import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';

// Render the real watch-page overlay, including its percentage and ARIA values.
test('preparation only shows a percentage when there is measurable progress', async () => {
  const source = new URL('../src/lib/PlaybackPreparation.svelte', import.meta.url);
  const compiled = new URL(`../src/lib/.preparation-test-${process.pid}.mjs`, import.meta.url);
  try {
    await writeFile(compiled, compile(await readFile(source, 'utf8'), { generate: 'server' }).js.code);
    const { default: Preparation } = await import(compiled.href);
    const html = props => render(Preparation, { props: { title: 'Fixture', detailed: true, ...props } }).body;
    for (const status of ['selecting', 'extracting', 'optimizing']) {
      const output = html({ status, progress: 45 });
      assert.doesNotMatch(output, /aria-valuenow|45%/, `${status} must not masquerade as measured progress`);
    }
    const output = html({ status: 'downloading', progress: 45,
      download: { completedSegments: 1, totalSegments: 10 } });
    assert.match(output, /aria-valuenow="10"/);
    assert.match(output, /10% downloaded/);
    assert.doesNotMatch(html({ status: 'downloading' }), /aria-valuenow/);
  } finally { await unlink(compiled).catch(() => {}); }
});
