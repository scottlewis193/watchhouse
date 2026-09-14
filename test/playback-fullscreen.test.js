import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';

const source = readFileSync(new URL('../src/routes/watch/[type]/[id]/+page.svelte', import.meta.url), 'utf8');
const ast = parse(source);
const fullscreenHandler = ast.instance.content.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'toggleFullscreen');

function elements(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...Object.values(node).flatMap(value => Array.isArray(value) ? value.flatMap(elements) : elements(value))];
}

test('the fullscreen player includes the watch toolbar', () => {
  const shell = elements(ast.html).find(node => node.type === 'Element' && node.attributes.some(attribute => attribute.type === 'Binding' && attribute.expression?.name === 'playerShell'));
  assert.ok(shell, 'the fullscreen player shell exists');
  const toolbar = shell.children.find(node => node.type === 'RenderTag' && node.expression.callee.name === 'watchToolbar');
  assert.ok(toolbar, 'watch actions must be descendants of the fullscreen element');
  assert.equal(toolbar.expression.arguments[0].value, true);
});

test('fullscreen toggles the shell containing the toolbar and can exit again', async () => {
  let entered = 0, exited = 0;
  const state = {
    playerShell: { requestFullscreen: async () => { entered++; } },
    document: { fullscreenElement: null, exitFullscreen: async () => { exited++; } }
  };
  runInNewContext(source.slice(fullscreenHandler.start, fullscreenHandler.end), state);
  await state.toggleFullscreen();
  assert.equal(entered, 1);
  state.document.fullscreenElement = state.playerShell;
  await state.toggleFullscreen();
  assert.equal(exited, 1);
});
