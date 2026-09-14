import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { analyzeCreditFrame, updateCreditEvidence } from '../src/lib/credit-detection.js';

test('S02E01 outdoor story scene does not trigger the credits countdown', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/fnd-s02e01-outdoor.json', import.meta.url), 'utf8'));
  const luminance = inflateSync(Buffer.from(fixture.luminance, 'base64'));
  const frameSize = fixture.width * fixture.height;
  assert.equal(luminance.length, fixture.frames * frameSize);
  let evidence = [];
  for (let frame = 0; frame < fixture.frames; frame++) {
    const pixels = new Uint8ClampedArray(frameSize * 4);
    for (let pixel = 0; pixel < frameSize; pixel++) {
      const value = luminance[frame * frameSize + pixel];
      pixels.set([value, value, value, 255], pixel * 4);
    }
    const analysis = analyzeCreditFrame(pixels, fixture.width, fixture.height);
    const result = updateCreditEvidence(evidence, analysis, frame * fixture.intervalMs);
    evidence = result.samples;
    assert.equal(result.detected, false, 'S02E01 outdoor story scene must not trigger credits');
  }
});

test('credit lettering is recognised across multiple rows, not just one dominant row', () => {
  const width = 160, height = 90;
  for (const rows of [1, 2, 4, 6]) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < rows; row++) {
      for (let glyph = 0; glyph < 8; glyph++) {
        for (let y = 10 + row * 12; y < 17 + row * 12; y++) {
          for (let x = 42 + glyph * 10; x < 45 + glyph * 10; x++) {
            pixels.set([245, 245, 245, 255], (y * width + x) * 4);
          }
        }
      }
    }
    const analysis = analyzeCreditFrame(pixels, width, height);
    assert.equal(analysis.likely, true, `${rows} rows of credit lettering should match`);
    let evidence = [];
    for (let frame = 0; frame < 5; frame++) {
      const result = updateCreditEvidence(evidence, analysis, frame * 2000);
      evidence = result.samples;
      assert.equal(result.detected, frame === 4);
    }
  }
});
