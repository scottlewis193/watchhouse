import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { conversionSucceeded, ffmpegArgs } from '../src/lib/server/streamer.js';
const run = promisify(execFile);

for (const permanent of [false, true]) test(permanent
  ? 'a persistent HTTP input failure stops within a bounded retry budget'
  : 'an interrupted HTTP input resumes without losing video frames', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchhouse-http-recovery-'));
  const input = join(root, 'source.mkv'), output = join(root, 'output.mp4');
  let server;
  try {
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-g', '25', '-c:a', 'aac', input]);
    const bytes = await readFile(input);
    let interrupted = false;
    server = createServer((req, res) => {
      const start = Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] || 0);
      res.writeHead(206, { 'content-length': bytes.length - start, 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`, 'accept-ranges': 'bytes' });
      if (!interrupted) {
        interrupted = true;
        res.write(bytes.subarray(start, Math.floor(bytes.length * 0.35) + 13), () => res.destroy());
      } else if (permanent) res.destroy();
      else res.end(bytes.subarray(start));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let converted;
    try {
      converted = await run('ffmpeg', ffmpegArgs('remux', `http://127.0.0.1:${server.address().port}/video`, output, false, 0, 1, true), { timeout: 10000 });
    } catch (error) {
      assert.equal(permanent, true, error.stderr);
      assert.equal(error.killed, false, 'FFmpeg must exhaust its retries instead of hanging');
      assert.equal(conversionSucceeded(error.code, error.stderr, 1, { httpReconnect: true }), false);
      return;
    }
    if (permanent) {
      assert.equal(conversionSucceeded(0, converted.stderr, 1, { httpReconnect: true }), false, 'truncated conversion must not be accepted as complete');
      return;
    }
    assert.equal(conversionSucceeded(0, converted.stderr, 1, { httpReconnect: true }), true, converted.stderr);
    const hashes = async path => (await run('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:v:0', '-f', 'framemd5', '-'])).stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
    assert.deepEqual(await hashes(output), await hashes(input), 'a dropped source connection must not discard or corrupt video frames');
    assert.equal(interrupted, true);
  } finally {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
