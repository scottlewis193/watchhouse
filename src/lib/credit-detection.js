const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function regionMetrics(luminance, width, height, left, top, right, bottom) {
  const histogram = new Uint32Array(256);
  const rowEdges = new Uint16Array(bottom - top);
  let dark = 0, bright = 0, strongEdges = 0, softEdges = 0, sum = 0, squaredSum = 0, total = 0;
  const regionWidth = right - left;

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const value = luminance[y * width + x];
      histogram[value]++;
      sum += value;
      squaredSum += value * value;
      if (value < 65) dark++;
      if (value > 170) bright++;
      if (x > left) {
        const difference = Math.abs(value - luminance[y * width + x - 1]);
        if (difference > 24) { softEdges++; rowEdges[y - top]++; }
        if (difference > 55) strongEdges++;
      }
      if (y > top) {
        const difference = Math.abs(value - luminance[(y - 1) * width + x]);
        if (difference > 24) { softEdges++; rowEdges[y - top]++; }
        if (difference > 55) strongEdges++;
      }
      total++;
    }
  }

  const percentile = (fraction) => {
    const target = total * fraction;
    let seen = 0;
    for (let value = 0; value < histogram.length; value++) {
      seen += histogram[value];
      if (seen >= target) return value;
    }
    return 255;
  };
  let dominant = 0;
  for (let start = 0; start < 256; start += 16) {
    let bucket = 0;
    for (let value = start; value < start + 16; value++) bucket += histogram[value];
    dominant = Math.max(dominant, bucket);
  }
  const mean = sum / total;
  const variance = Math.max(0, squaredSum / total - mean * mean);
  const activeRowThreshold = Math.max(2, Math.ceil(regionWidth * 0.025));
  let activeRows = 0;
  for (const count of rowEdges) if (count >= activeRowThreshold) activeRows++;

  return {
    darkFraction: dark / total,
    brightFraction: bright / total,
    edgeDensity: strongEdges / (total * 2),
    softEdgeDensity: softEdges / (total * 2),
    activeRowFraction: activeRows / rowEdges.length,
    dominantFraction: dominant / total,
    contrast: percentile(0.98) - percentile(0.02),
    meanLuminance: mean,
    luminanceDeviation: Math.sqrt(variance)
  };
}

function compactComponentFraction(luminance, width, height, matches) {
  const visited = new Uint8Array(luminance.length);
  const stack = new Int32Array(luminance.length);
  const maximumCompactSize = Math.max(12, Math.floor(luminance.length * 0.02));
  let matchingPixels = 0, compactPixels = 0;

  for (let start = 0; start < luminance.length; start++) {
    if (visited[start] || !matches(luminance[start])) continue;
    let stackSize = 1, componentSize = 0;
    stack[0] = start;
    visited[start] = 1;
    while (stackSize) {
      const pixel = stack[--stackSize], x = pixel % width, y = Math.floor(pixel / width);
      componentSize++;
      const neighbours = [x > 0 ? pixel - 1 : -1, x + 1 < width ? pixel + 1 : -1, y > 0 ? pixel - width : -1, y + 1 < height ? pixel + width : -1];
      for (const neighbour of neighbours) {
        if (neighbour >= 0 && !visited[neighbour] && matches(luminance[neighbour])) {
          visited[neighbour] = 1;
          stack[stackSize++] = neighbour;
        }
      }
    }
    matchingPixels += componentSize;
    if (componentSize <= maximumCompactSize) compactPixels += componentSize;
  }

  return matchingPixels ? compactPixels / matchingPixels : 0;
}

export function analyzeCreditFrame(pixels, width, height) {
  if (!pixels || !Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8 || pixels.length < width * height * 4) {
    return { likely: false, confidence: 0, profile: 'invalid', metrics: null };
  }

  const luminance = new Uint8Array(width * height);
  for (let pixel = 0; pixel < luminance.length; pixel++) {
    const offset = pixel * 4;
    luminance[pixel] = Math.round((pixels[offset] * 3 + pixels[offset + 1] * 6 + pixels[offset + 2]) / 10);
  }
  const whole = regionMetrics(luminance, width, height, 0, 0, width, height);
  const center = regionMetrics(
    luminance,
    width,
    height,
    Math.floor(width * 0.25),
    Math.floor(height * 0.25),
    Math.ceil(width * 0.75),
    Math.ceil(height * 0.75)
  );
  const compactBrightFraction = compactComponentFraction(luminance, width, height, value => value > 170);
  const compactDarkFraction = compactComponentFraction(luminance, width, height, value => value < 65);
  const edgeConcentration = center.softEdgeDensity / Math.max(whole.softEdgeDensity, 0.0001);
  const profiles = [
    {
      name: 'dark', confidence: 1,
      matches: whole.darkFraction >= 0.68 && whole.brightFraction >= 0.008 && whole.brightFraction <= 0.28
        && whole.edgeDensity >= 0.008 && whole.edgeDensity <= 0.28 && center.edgeDensity >= 0.003
        && compactBrightFraction >= 0.5
    },
    {
      name: 'sparse-centered', confidence: 1,
      matches: whole.darkFraction >= 0.9 && center.darkFraction >= 0.82
        && center.brightFraction >= 0.01 && center.brightFraction <= 0.22
        && center.edgeDensity >= 0.004 && center.edgeDensity <= 0.25
    },
    {
      name: 'light', confidence: 0.95,
      matches: whole.brightFraction >= 0.68 && whole.darkFraction >= 0.008 && whole.darkFraction <= 0.28
        && whole.edgeDensity >= 0.008 && whole.edgeDensity <= 0.28 && center.edgeDensity >= 0.003
        && compactDarkFraction >= 0.5
    },
    {
      name: 'uniform-color', confidence: 0.9,
      matches: whole.dominantFraction >= 0.52 && center.contrast >= 32
        && center.softEdgeDensity >= 0.006 && center.softEdgeDensity <= 0.28
        && center.activeRowFraction >= 0.04 && center.activeRowFraction <= 0.72
    },
    {
      name: 'text-overlay', confidence: 0.68,
      matches: whole.dominantFraction < 0.52 && center.contrast >= 52
        && center.softEdgeDensity >= 0.012 && center.softEdgeDensity <= 0.22
        && center.activeRowFraction >= 0.08 && center.activeRowFraction <= 0.52
        && edgeConcentration >= 1.25
    }
  ];
  const match = profiles.find(profile => profile.matches);
  const metrics = {
    ...whole,
    centerDarkFraction: center.darkFraction,
    centerBrightFraction: center.brightFraction,
    centerEdgeDensity: center.edgeDensity,
    centerSoftEdgeDensity: center.softEdgeDensity,
    centerActiveRowFraction: center.activeRowFraction,
    centerDominantFraction: center.dominantFraction,
    centerContrast: center.contrast,
    edgeConcentration,
    compactBrightFraction,
    compactDarkFraction
  };
  return {
    likely: Boolean(match),
    confidence: match?.confidence || 0,
    profile: match?.name || 'none',
    metrics
  };
}

export function updateCreditEvidence(evidence, analysis, now = Date.now(), maximumAge = 10_000) {
  const previous = Array.isArray(evidence) ? evidence : [];
  const recent = previous
    .filter(sample => Number.isFinite(sample?.at) && now - sample.at <= maximumAge)
    .slice(-3);
  const confidence = typeof analysis === 'boolean'
    ? Number(analysis)
    : clamp(Number(analysis?.confidence) || 0, 0, 1);
  const samples = [...recent, { confidence, likely: confidence >= 0.6, at: now }];
  const matches = samples.reduce((total, sample) => total + Number(sample.likely), 0);
  const strongMatches = samples.reduce((total, sample) => total + Number(sample.confidence >= 0.9), 0);
  const confidenceTotal = samples.reduce((total, sample) => total + sample.confidence, 0);
  const detected = (samples.length >= 3 && strongMatches >= 2 && confidenceTotal >= 1.8)
    || (samples.length >= 4 && matches >= 3 && confidenceTotal >= 2);
  return { samples, matches, sampleCount: samples.length, confidenceTotal, detected };
}
