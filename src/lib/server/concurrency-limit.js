export function concurrencyLimit(width) {
  let active = 0;
  const waiting = [];
  return async task => {
    if (active >= width) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try { return await task(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}
