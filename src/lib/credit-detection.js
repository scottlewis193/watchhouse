const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function regionMetrics(luminance, width, height, left, top, right, bottom) {
  const histogram = new Uint32Array(256);
  let dark = 0, bright = 0, strongEdges = 0, sum = 0, total = 0;

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const value = luminance[y * width + x];
      histogram[value]++;
      sum += value;
      if (value < 65) dark++;
      if (value > 170) bright++;
      if (x > left) {
        const difference = Math.abs(value - luminance[y * width + x - 1]);
        if (difference > 55) strongEdges++;
      }
      if (y > top) {
        const difference = Math.abs(value - luminance[(y - 1) * width + x]);
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

  return {
    darkFraction: dark / total,
    brightFraction: bright / total,
    edgeDensity: strongEdges / (total * 2),
    meanLuminance: sum / total,
    medianLuminance: percentile(0.5)
  };
}

function textComponentMetrics(luminance, width, height, threshold) {
  const visited = new Uint8Array(luminance.length);
  const stack = new Int32Array(luminance.length);
  const maximumCompactSize = Math.max(12, Math.floor(luminance.length * 0.02));
  const maximumCompactWidth = Math.max(3, Math.floor(width * 0.22));
  const maximumCompactHeight = Math.max(3, Math.floor(height * 0.22));
  const componentRows = new Uint16Array(height);
  let matchingPixels = 0, compactPixels = 0, compactComponentCount = 0;
  let compactLeft = width, compactTop = height, compactRight = -1, compactBottom = -1;

  for (let start = 0; start < luminance.length; start++) {
    if (visited[start] || luminance[start] < threshold) continue;
    let stackSize = 1, componentSize = 0;
    let left = width, top = height, right = -1, bottom = -1;
    stack[0] = start;
    visited[start] = 1;
    while (stackSize) {
      const pixel = stack[--stackSize], x = pixel % width, y = Math.floor(pixel / width);
      componentSize++;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      const neighbours = [x > 0 ? pixel - 1 : -1, x + 1 < width ? pixel + 1 : -1, y > 0 ? pixel - width : -1, y + 1 < height ? pixel + width : -1];
      for (const neighbour of neighbours) {
        if (neighbour >= 0 && !visited[neighbour] && luminance[neighbour] >= threshold) {
          visited[neighbour] = 1;
          stack[stackSize++] = neighbour;
        }
      }
    }
    matchingPixels += componentSize;
    const componentWidth = right - left + 1, componentHeight = bottom - top + 1;
    if (componentSize >= 2 && componentSize <= maximumCompactSize && componentWidth <= maximumCompactWidth && componentHeight <= maximumCompactHeight) {
      compactPixels += componentSize;
      compactComponentCount++;
      compactLeft = Math.min(compactLeft, left); compactTop = Math.min(compactTop, top);
      compactRight = Math.max(compactRight, right); compactBottom = Math.max(compactBottom, bottom);
      componentRows[Math.round((top + bottom) / 2)]++;
    }
  }

  let alignedComponentCount = 0;
  for (let row = 0; row < height; row++) {
    let aligned = 0;
    for (let nearby = Math.max(0, row - 2); nearby <= Math.min(height - 1, row + 2); nearby++) aligned += componentRows[nearby];
    alignedComponentCount = Math.max(alignedComponentCount, aligned);
  }
  return {
    foregroundFraction: matchingPixels / luminance.length,
    compactForegroundFraction: matchingPixels ? compactPixels / matchingPixels : 0,
    compactComponentCount,
    alignedComponentCount,
    compactHorizontalSpan: compactRight >= compactLeft ? (compactRight - compactLeft + 1) / width : 0,
    compactTopFraction: compactBottom >= compactTop ? compactTop / height : 1
  };
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
  const foregroundThreshold = Math.max(110, whole.medianLuminance + 70);
  const text = textComponentMetrics(luminance, width, height, foregroundThreshold);
  const darkBackground = whole.darkFraction >= 0.75 && whole.meanLuminance <= 72;
  const textShape = text.foregroundFraction >= 0.003 && text.foregroundFraction <= 0.16
    && text.compactForegroundFraction >= 0.65 && text.compactComponentCount >= 4
    && text.alignedComponentCount >= 4 && text.compactHorizontalSpan >= 0.12
    && text.compactTopFraction < 0.72;
  const likely = darkBackground && textShape;
  const metrics = {
    ...whole,
    centerDarkFraction: center.darkFraction,
    centerBrightFraction: center.brightFraction,
    centerEdgeDensity: center.edgeDensity,
    foregroundThreshold,
    ...text
  };
  return {
    likely,
    confidence: likely ? 1 : 0,
    profile: likely ? 'dark-text' : 'none',
    metrics
  };
}

export function updateCreditEvidence(evidence, analysis, now = Date.now(), maximumAge = 10_000) {
  const previous = Array.isArray(evidence) ? evidence : [];
  const recent = previous
    .filter(sample => Number.isFinite(sample?.at) && now - sample.at <= maximumAge)
    .slice(-5);
  const confidence = typeof analysis === 'boolean'
    ? Number(analysis)
    : clamp(Number(analysis?.confidence) || 0, 0, 1);
  const samples = [...recent, { confidence, likely: confidence >= 0.6, at: now }];
  const matches = samples.reduce((total, sample) => total + Number(sample.likely), 0);
  const confidenceTotal = samples.reduce((total, sample) => total + sample.confidence, 0);
  const evidenceSpan = samples.length > 1 ? now - samples[0].at : 0;
  const sustainedEvidence = samples.length >= 5 && evidenceSpan >= 8_000;
  const detected = sustainedEvidence && matches >= 4;
  return { samples, matches, sampleCount: samples.length, confidenceTotal, detected };
}
