import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceProbe } from '../src/lib/server/source-probe.js';
import { createServer } from 'node:http';

const run = promisify(execFile);

async function withSource(inspect) {
  const root = await mkdtemp(join(tmpdir(), 'source-probe-'));
  try {
    const input = join(root, 'tracks.mkv');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=24',
      '-itsoffset', '3', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=21',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:a', 'aac', '-metadata:s:a:0', 'language=fra', '-metadata:s:a:1', 'language=eng', input]);
    await inspect(input);
  } finally { await rm(root, { recursive: true, force: true }); }
}

const execute = async args => (await run('ffprobe', args)).stdout;

test('metadata reuse preserves every source track, including audio starting three seconds late', { timeout: 20000 }, async () => {
  await withSource(async input => {
    const probe = createSourceProbe();
    let executions = 0;
    const options = { input, execute: async args => { executions++; return execute(args); } };
    const first = await probe(options);
    const standard = JSON.parse(await execute(['-v', 'error', '-rw_timeout', '15000000',
      '-show_entries', 'format=duration:stream=index,codec_type,codec_name,r_frame_rate,avg_frame_rate:stream_tags=language,title,handler_name',
      '-of', 'json', input]));
    assert.deepEqual(first, standard, 'cold metadata must retain the exact standard-probe result shape');
    assert.deepEqual(first.streams.filter(stream => stream.codec_type === 'audio').map(stream => [stream.index, stream.tags.language]), [[1, 'fra'], [2, 'eng']]);
    assert.equal(first.streams.find(stream => stream.codec_type === 'video').codec_name, 'h264');
    assert.ok(Number(first.format.duration) >= 24);
    assert.equal(first.streams.find(stream => stream.codec_type === 'video').r_frame_rate, '25/1');
    const opening = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=index,start_time', '-of', 'json', input])).stdout);
    assert.ok(Number(opening.streams.find(stream => stream.index === 2).start_time) > 2.9, 'the English fixture track must really start late');
    const second = await probe(options);
    assert.deepEqual(second, first);
    assert.equal(executions, 1, 'unchanged content must not require another metadata read');
    first.streams.pop();
    assert.equal((await probe(options)).streams.length, 3, 'callers cannot mutate cached track choices');
  });
});

test('stored archive reuse invalidates changed articles, member choices and policy scopes', { timeout: 20000 }, async () => {
  await withSource(async input => {
    const probe = createSourceProbe();
    let executions = 0;
    const archives = [{ segments: [{ id: 'volume-one@example', number: 1, bytes: 1024 }] }];
    const archiveSource = { randomAccess: true, complete: true, metadata: { name: 'tracks.mkv', size: 4096 } };
    const options = { input, archives, archiveSource, scope: 'policy-a', execute: async args => { executions++; return execute(args); } };
    assert.equal((await probe(options)).streams.length, 3);
    assert.equal((await probe(options)).streams.length, 3);
    assert.equal(executions, 1);
    archives[0].segments[0].id = 'replacement@example';
    assert.equal((await probe(options)).streams.length, 3);
    assert.equal(executions, 2, 'different published articles must invalidate the old result');
    archives[0].segments[0].bytes++;
    await probe(options);
    assert.equal(executions, 3, 'changed byte layout must invalidate the old result');
    const selected = `${input}.english.mkv`;
    await run('ffmpeg', ['-v', 'error', '-i', input, '-map', '0:v', '-map', '0:a:1', '-c', 'copy', selected]);
    archiveSource.metadata = { name: 'english.mkv', size: 3072 };
    const changed = await probe({ ...options, input: selected });
    assert.deepEqual(changed.streams.filter(stream => stream.codec_type === 'audio').map(stream => stream.tags.language), ['eng']);
    assert.equal(executions, 4, 'a newly selected member cannot inherit another video’s audio choices');
    await probe({ ...options, input: selected, scope: 'policy-b' });
    assert.equal(executions, 5, 'metadata cannot leak across playback policy scopes');
  });
});

test('unsafe or incomplete archive identities fall back to full probing without dropping late audio', { timeout: 20000 }, async () => {
  await withSource(async input => {
    const probe = createSourceProbe();
    let executions = 0;
    const options = { input, archives: [{ segments: [{ id: 'article@example' }] }],
      archiveSource: { randomAccess: false, complete: false, metadata: { name: 'tracks.mkv', size: 4096 } },
      execute: async args => { executions++; return execute(args); } };
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual((await probe(options)).streams.filter(stream => stream.codec_type === 'audio').map(stream => stream.tags.language), ['fra', 'eng']);
    }
    assert.equal(executions, 2, 'growing extraction must be reprobed, never trusted from an earlier prefix');
    options.archiveSource.randomAccess = true;
    options.archiveSource.complete = true;
    options.archives = [];
    await probe(options);
    await probe(options);
    assert.equal(executions, 4, 'unverified article identity must not become a cache key');
  });
});

test('combined inspection always reads fresh packets covering the opening twenty seconds', { timeout: 20000 }, async () => {
  await withSource(async input => {
    const probe = createSourceProbe();
    let executions = 0;
    const options = { input, execute: async args => { executions++; return execute(args); } };
    await probe(options);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await probe({ ...options, combined: true });
      assert.equal(result.streams.length, 3);
      const video = result.streams.find(stream => stream.codec_type === 'video');
      assert.equal(video.r_frame_rate, '25/1', 'repair frame rate must remain available');
      assert.ok(result.packets.some(packet => packet.stream_index === video.index && Number(packet.dts_time) >= 19));
      assert.ok(result.packets.some(packet => packet.stream_index === 2 && Number(packet.dts_time) > 3));
    }
    assert.equal(executions, 3, 'metadata reuse cannot stand in for either timeline validation');
  });
});

test('failed and cancelled metadata reads never become reusable results', { timeout: 20000 }, async () => {
  await withSource(async input => {
    const probe = createSourceProbe();
    const source = { segments: [{ id: 'immutable@example', decodedBytes: 4096 }] };
    const controller = new AbortController();
    const cancelled = new Error('Playback was cancelled');
    let executions = 0;
    const options = { input, source, execute: async args => { executions++; return execute(args); } };
    await assert.rejects(probe({ ...options, execute: args => options.execute([...args.slice(0, -1), `${input}.missing`]) }));
    assert.equal(executions, 1);
    await assert.rejects(probe({ ...options, signal: controller.signal, execute: async args => {
      const output = await options.execute(args);
      controller.abort(cancelled);
      return output;
    } }), error => error === cancelled);
    assert.equal(executions, 2);
    assert.equal((await probe(options)).streams.length, 3);
    assert.equal(executions, 3, 'the cancelled successful child output must not be cached');
    await assert.rejects(probe({ ...options, signal: controller.signal }), error => error === cancelled);
    assert.equal(executions, 3, 'an aborted caller must not receive even a cached result');
    assert.equal((await probe(options)).streams.length, 3);
    assert.equal(executions, 3);
  });
});

test('local file replacement and bounded eviction cannot retain old track metadata', { timeout: 20000 }, async () => {
  await withSource(async input => {
    const probe = createSourceProbe({ maximumEntries: 1 });
    let executions = 0;
    const options = { input, execute: async args => { executions++; return execute(args); } };
    await probe(options);
    const selected = `${input}.french.mkv`;
    await run('ffmpeg', ['-v', 'error', '-i', input, '-map', '0:v', '-map', '0:a:0', '-c', 'copy', selected]);
    assert.equal((await probe({ ...options, input: selected })).streams.length, 2);
    await probe(options);
    assert.equal(executions, 3, 'only one verified result can remain resident');
    await writeFile(input, await readFile(selected));
    assert.equal((await probe(options)).streams.length, 2);
    assert.equal(executions, 4, 'rewriting a file in place must invalidate its previous version');
    await rename(selected, input);
    assert.equal((await probe(options)).streams.length, 2);
    assert.equal(executions, 5, 'replacing a pathname must invalidate the old inode identity');
    const uncached = createSourceProbe({ maximumBytes: 1 });
    await uncached(options);
    await uncached(options);
    assert.equal(executions, 7, 'oversized probe results must not escape the byte bound');
  });
});

test('HTTP Matroska inspection preserves all tracks and opening packets without tail/index requests, with seekable fallback', { timeout: 20000 }, async () => {
  await withSource(async file => {
    const bytes = await readFile(file), starts = [];
    let requireRanges = false;
    const server = createServer((req, res) => {
      if (requireRanges && !req.headers.range) { res.writeHead(403); res.end(); return; }
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const start = match ? Number(match[1]) : 0, end = match?.[2] ? Number(match[2]) : bytes.length - 1;
      starts.push(start);
      res.writeHead(match ? 206 : 200, {
        'content-length': end - start + 1, 'accept-ranges': 'bytes',
        ...(match ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {})
      });
      res.end(bytes.subarray(start, end + 1));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const standard = await createSourceProbe()({ input: file, execute });
      for (const restricted of [false, true]) {
        starts.length = 0; requireRanges = restricted;
        const result = await createSourceProbe()({
          input: `http://127.0.0.1:${server.address().port}/video`, combined: true, execute,
          source: { subject: '\"tracks.mkv\" yEnc', segments: [{ id: 'fixture', decodedBytes: bytes.length }] }
        });
        assert.deepEqual(result.streams, standard.streams);
        assert.deepEqual(result.format, standard.format);
        assert.ok(result.packets.some(packet => packet.stream_index === 0 && Number(packet.dts_time) < 0.1), 'analysis must not discard the opening packets');
        assert.ok(result.packets.some(packet => packet.stream_index === 0 && Number(packet.dts_time) >= 19), 'retain the full opening timeline');
        assert.ok(result.packets.some(packet => packet.stream_index === 2 && Number(packet.dts_time) > 3), 'retain delayed English audio');
        if (!restricted) assert.deepEqual(starts, [0], 'container indices must not trigger extra tail and return seeks');
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
});
