import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackTracks } from '../src/lib/server/playback-tracks.js';
import { captionsAtOffset } from '../src/lib/captions.js';

test('source track choices retain indices and distinguish bitmap captions', () => {
  assert.deepEqual(playbackTracks([{index:2,codec_type:'audio',tags:{language:'eng'}},{index:4,codec_type:'subtitle',codec_name:'subrip'},{index:5,codec_type:'subtitle',codec_name:'hdmv_pgs_subtitle'}]).map(t=>[t.index,t.type,t.supported]), [[2,'audio',true],[4,'captions',true],[5,'captions',false]]);
});
test('local captions shift to the session offset and discard expired cues', () => {
  const text='WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOld\n\n00:00:09.000 --> 00:00:12.500\nStill here\n\n00:00:15.000 --> 00:00:17.000 align:start\nNext';
  const shifted=captionsAtOffset(text,10);
  assert.ok(!shifted.includes('Old'));
  assert.ok(shifted.includes('00:00:00.000 --> 00:00:02.500'));
  assert.ok(shifted.includes('00:00:05.000 --> 00:00:07.000 align:start'));
  assert.throws(()=>captionsAtOffset('not a caption file'));
});

test('real multi-track source selects the requested language and converts text captions', {timeout:15000}, async () => {
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
  const {startHlsConversion}=await import('../src/lib/server/streamer.js'),{createHlsSession}=await import('../src/lib/server/hls-session.js'),{extractCaptions}=await import('../src/lib/server/playback-tracks.js');
  const run=promisify(execFile),root=await mkdtemp(join(tmpdir(),'playback-tracks-'));let session;
  try{
    const input=join(root,'tracks.mkv'),captions=join(root,'captions.srt');
    await writeFile(captions,'1\n00:00:01,000 --> 00:00:03,000\nEarly\n\n2\n00:00:06,000 --> 00:00:08,000\nLater\n');
    await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=25:duration=10','-f','lavfi','-i','sine=frequency=440:duration=10','-f','lavfi','-i','sine=frequency=880:duration=10','-i',captions,'-map','0:v','-map','1:a','-map','2:a','-map','3:s','-c:v','libx264','-preset','ultrafast','-c:a','aac','-c:s','srt','-metadata:s:a:0','language=eng','-metadata:s:a:1','language=fra',input]);
    const job={mode:'cached-convert',sourcePath:input,strategy:'remux',release:'SDR',events:[]};
    session=await createHlsSession({root,produce:directory=>startHlsConversion(job,{},0,directory,undefined,undefined,undefined,{audioTrack:2})});await session.ready();
    const probe=JSON.parse((await run('ffprobe',['-v','error','-show_entries','stream=codec_type:stream_tags=language','-of','json',join(session.directory,'index.m3u8')])).stdout);
    assert.equal(job.selectedAudioTrack,2);assert.equal(job.playbackTracks.filter(t=>t.type==='audio').length,2);
    assert.equal(probe.streams.filter(s=>s.codec_type==='audio').length,1);
    // HLS language tags vary between FFmpeg versions; check the selected audio itself.
    const {stdout:pcm}=await run('ffmpeg',['-v','error','-i',join(session.directory,'index.m3u8'),'-map','0:a:0','-t','1','-ac','1','-ar','8000','-f','s16le','pipe:1'],{encoding:'buffer'});
    let risingCrossings=0;
    for(let offset=2;offset<pcm.length;offset+=2){
      if(pcm.readInt16LE(offset-2)<=0 && pcm.readInt16LE(offset)>0) risingCrossings++;
    }
    const frequency=risingCrossings/(pcm.length/2/8000);
    assert.ok(Math.abs(frequency-880)<30,`expected the French 880 Hz track, got ${frequency.toFixed(1)} Hz`);
    const text=await extractCaptions(input,3,5);
    assert.ok(text.includes('Later'));assert.ok(!text.includes('Early'));assert.ok(text.includes('00:00:01.000'));
    const started=performance.now();session.playbackState({paused:true,position:0});await session.close();
    assert.ok(performance.now()-started<1500,'a paused converter must still stop promptly');
  }finally{await session?.close();await rm(root,{recursive:true,force:true});}
});
