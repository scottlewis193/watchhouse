import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('the production image supports VAAPI and NVIDIA devices as an unprivileged user', async () => {
  const [dockerfile, entrypoint, readme] = await Promise.all([
    readFile(new URL('Dockerfile', root), 'utf8'),
    readFile(new URL('docker-entrypoint.sh', root), 'utf8').catch(() => ''),
    readFile(new URL('README.md', root), 'utf8')
  ]);

  const runtime = dockerfile.split('FROM node:24-bookworm-slim AS runtime')[1] || '';
  assert.match(runtime, /\bintel-media-va-driver\b/, 'Intel Gen8+ VAAPI driver must be installed in the runtime image');
  assert.match(runtime, /ENTRYPOINT \["docker-entrypoint\.sh"\]/, 'runtime must initialise render-device permissions');
  assert.match(entrypoint, /\/dev\/dri\/renderD\*/, 'entrypoint must inspect mounted render nodes');
  assert.match(entrypoint, /\/dev\/nvidia\*/, 'entrypoint must inspect NVIDIA runtime devices');
  assert.match(entrypoint, /usermod -aG/, 'node must join the render node\'s host group');
  assert.match(readme, /--device \/dev\/dri:\/dev\/dri/, 'documented Docker launch must expose the GPU');
  assert.match(readme, /--gpus all/, 'documented Docker launch must expose NVIDIA GPUs');
});
