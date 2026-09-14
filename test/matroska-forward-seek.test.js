import test from 'node:test';
import assert from 'node:assert/strict';
import { matroskaSeekHeadPatches } from '../src/lib/server/matroska-forward-seek.js';
const element = (id, body) => Buffer.concat([Buffer.from(id,'hex'), Buffer.from([0x80|body.length]),body]);
test('forward view replaces only complete SeekHead elements with equal-length EBML Void', () => {
  const seek = element('114d9b74',Buffer.alloc(30,42));
  const tracks = element('1654ae6b',Buffer.from('tracks'));
  const cluster = element('1f43b675',seek);
  const header = Buffer.concat([element('1a45dfa3',Buffer.alloc(0)),Buffer.from('1853806701ffffffffffffff','hex'),seek,tracks,cluster]);
  const patches = matroskaSeekHeadPatches(header);
  assert.equal(patches.length,1,'SeekHead-looking media bytes are never rewritten');
  assert.equal(patches[0].bytes.length,seek.length);
  assert.equal(patches[0].bytes[0],0xec);
  assert.equal(patches[0].bytes[1]&0x7f,seek.length-2);
  assert.equal(patches[0].offset,17);
  assert.deepEqual(matroskaSeekHeadPatches(header.subarray(0,20)),[],'incomplete headers are left alone');
  assert.deepEqual(matroskaSeekHeadPatches(Buffer.from('not a Matroska container')),[]);
});
