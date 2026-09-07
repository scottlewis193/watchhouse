import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stopConversion } from '../src/lib/server/conversion-process.js';

test('stops a converter that cannot finish graceful shutdown', { timeout: 5000 }, async t => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"]);
  t.after(() => child.kill('SIGKILL'));
  try {
    await once(child.stdout, 'data', { signal: t.signal });
    const exited = once(child, 'exit');
    stopConversion(child);
    const result = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), 1500))]);
    assert.notEqual(result, null, 'converter must not outlive its cancelled stream');
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stdin.destroyed, true);
  } finally { child.kill('SIGKILL'); }
});
