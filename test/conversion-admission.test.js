import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversionAdmission} from '../src/lib/server/conversion-admission.js';
test('foreground queued work wins over downloads and canceled waiters release capacity', async()=>{
  const pool=createConversionAdmission({limit:1}),first=await pool.acquire(),order=[];
  const controller=new AbortController();
  const canceled=pool.acquire({signal:controller.signal});void canceled.catch(()=>{});
  const background=pool.acquire({foreground:false}).then(release=>{order.push('background');release();});
  const foreground=pool.acquire().then(release=>{order.push('foreground');release();});
  controller.abort();await assert.rejects(canceled);first();await foreground;await background;
  assert.deepEqual(order,['foreground','background']);assert.equal(pool.stats().active,0);
});
