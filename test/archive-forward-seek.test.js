import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startHlsConversion } from '../src/lib/server/streamer.js';
import { createHlsSession } from '../src/lib/server/hls-session.js';
const run = promisify(execFile);

test('cold growing Matroska resumes by seeking through available bytes with matching video and audio', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-forward-seek-'));
  let server, session, baseline;
  try {
    const input = join(root, 'source.mkv');
    await run('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-f','lavfi','-i','sine=frequency=440','-t','60','-c:v','libx264','-preset','ultrafast','-g','48','-c:a','aac','-metadata:s:a:0','language=eng',input]);
    const bytes = await readFile(input), available = Math.floor(bytes.length * .85), ranges = [];
    server = createServer((req,res) => {
      const start = Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] || 0);
      ranges.push(start);
      res.writeHead(206, { 'content-length': bytes.length-start, 'content-range': `bytes ${start}-${bytes.length-1}/${bytes.length}`, 'accept-ranges':'bytes' });
      if (start < available) res.write(bytes.subarray(start, available));
      // The unfinished tail stays unavailable until test cleanup.
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const source = { complete:false, available, metadata:{name:'source.mkv',size:bytes.length}, retain: () => ({url:`http://127.0.0.1:${server.address().port}/video`,close:async()=>{}}) };
    const job = { progressiveArchive:true, archiveSource:source, file:{subject:'source.mkv'}, strategy:'remux',mode:'direct',release:'SDR' };
    session = await createHlsSession({root,produce:directory=>startHlsConversion(job,{},40.123,directory)});
    await Promise.race([session.ready(),new Promise((_,reject)=>{ const timer=setTimeout(()=>reject(Error('Resume waited for missing archive tail')),8000);timer.unref(); })]);
    assert.ok(ranges.some(start=>start>bytes.length*.2 && start<available), 'resume must skip available prefix bytes instead of decoding from byte zero');
    baseline = await createHlsSession({root,produce:directory=>startHlsConversion({mode:'cached-convert',sourcePath:input,strategy:'remux',release:'SDR'}, {},40.123,directory)});
    await baseline.ready();
    for (const type of ['v','a']) {
      const hashes = async s => (await run('ffmpeg',['-v','error','-i',join(s.directory,'index.m3u8'),'-map',`0:${type}:0`,`-frames:${type}`,'24','-f','framemd5','-'])).stdout.split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').slice(2).join(','));
      assert.deepEqual(await hashes(session),await hashes(baseline), `${type} output and timing must match a normal accurate seek`);
    }
  } finally { await session?.close(); await baseline?.close(); server?.closeAllConnections(); if(server)await new Promise(r=>server.close(r)); await rm(root,{recursive:true,force:true}); }
});
