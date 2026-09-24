import { conversionAdmission } from './conversion-admission.js';
import { captionsAtOffset } from '../captions.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const textCodecs = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

export function playbackTracks(streams = []) {
  return streams.filter(stream => ['audio', 'subtitle'].includes(stream.codec_type) && Number.isInteger(stream.index)).map(stream => ({
    index: stream.index,
    type: stream.codec_type === 'audio' ? 'audio' : 'captions',
    language: stream.tags?.language || 'und',
    label: stream.tags?.title || stream.tags?.handler_name || stream.tags?.language || `${stream.codec_type === 'audio' ? 'Audio' : 'Captions'} ${stream.index + 1}`,
    supported: stream.codec_type === 'audio' || textCodecs.has(stream.codec_name)
  }));
}

export function hasEnglishAudioTrack(tracks = []) {
  return tracks.some(track => track.type === 'audio' && (
    /^(?:eng|en)(?:-[a-z]{2})?$/i.test(track.language || '')
    || /\b(?:english|eng)\b/i.test(track.label || '')
  ));
}

export async function extractCaptions(path, index, start = 0, signal) {
  const release = await conversionAdmission.acquire({ signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
  try {
  // Keep source cue timestamps aligned with the playback seek offset.
  const { stdout } = await execute('ffmpeg', ['-nostdin', '-v', 'error', '-copyts', '-i', path, '-map', `0:${index}`, '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1'], { signal, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  return captionsAtOffset(stdout, start);
  } finally { release(); }
}
