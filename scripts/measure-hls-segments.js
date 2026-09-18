// Local synthetic comparison. No provider, history, settings or existing cache access.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { hlsOutputArgs } from '../src/lib/server/hls-session.js';
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'segment-measurement-'));
const results = [];
try {
  const input = join(root, 'source.mkv');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=8', '-f', 'lavfi', '-i', 'sine=duration=8', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', input]);
  for (const mode of ['remux', 'transcode']) for (let trial = 0; trial < 3; trial++) for (const seconds of trial % 2 ? [2,4] : [4,2]) {
    const directory = join(root, `${mode}-${trial}-${seconds}`); await mkdir(directory);
    const mapped = ['-v', 'error', '-i', input, '-map', '0:v', '-map', '0:a', ...(mode === 'remux' ? ['-c', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-force_key_frames', `expr:gte(t,n_forced*${seconds})`, '-c:a', 'aac', '-b:a', '192k']), '-movflags', '+faststart'];
    const start = performance.now();
    const child = spawn('ffmpeg', hlsOutputArgs(mapped, directory, seconds)); const exited = once(child,'close'); let failure='';
    child.stderr.on('data',chunk=>failure+=chunk); let first=null;
    while (child.exitCode === null && first === null) {
      const text=await readFile(join(directory,'index.m3u8'),'utf8').catch(()=> '');
      if (text.includes('#EXTINF:')) first=performance.now()-start;
      else await new Promise(resolve=>setTimeout(resolve,5));
    }
    const [code]=await exited; if (code) throw new Error(failure);
    first ??=performance.now()-start;
    const files=await readdir(directory), playlist=await readFile(join(directory,'index.m3u8'),'utf8');
    const bytes=(await Promise.all(files.map(file=>stat(join(directory,file)).then(info=>info.size)))).reduce((a,b)=>a+b,0);
    const probe=JSON.parse((await run('ffprobe',['-v','error','-show_entries','stream=codec_type,width,height','-of','json',join(directory,'index.m3u8')])).stdout);
    if (!probe.streams.some(s=>s.codec_type==='audio') || !probe.streams.some(s=>s.width===640&&s.height===360)) throw new Error('Output tracks or dimensions changed');
    results.push({mode,trial,seconds,firstMs:Math.round(first),totalMs:Math.round(performance.now()-start),segments:(playlist.match(/#EXTINF:/g)||[]).length,bytes});
  }
  console.log(JSON.stringify({fixture:'8 seconds, 640x360 SDR with AAC; unpaced local input',results},null,2));
} finally { await rm(root,{recursive:true,force:true}); }
