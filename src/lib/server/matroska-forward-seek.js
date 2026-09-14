// Hide SeekHead only in the forward-seek view. EBML Void preserves every byte
// offset; Info, Tracks and media remain untouched and are discovered in order.
export function matroskaSeekHeadPatches(header) {
  function vint(offset, id = false) {
    const first = header[offset];
    if (!first) return null;
    let width = 1;
    while (width <= 8 && !(first & (1 << (8 - width)))) width++;
    if (width > (id ? 4 : 8) || offset + width > header.length) return null;
    let value = BigInt(id ? first : first & ((1 << (8 - width)) - 1));
    for (let i = 1; i < width; i++) value = value * 256n + BigInt(header[offset + i]);
    return { width, value };
  }
  function element(offset) {
    const id = vint(offset, true);
    if (!id) return null;
    const size = vint(offset + id.width);
    if (!size) return null;
    return { id: Number(id.value), data: offset + id.width + size.width, size: Number(size.value) };
  }
  const ebml = element(0);
  if (!ebml || ebml.id !== 0x1a45dfa3) return [];
  const segment = element(ebml.data + ebml.size);
  if (!segment || segment.id !== 0x18538067) return [];
  const patches = [];
  for (let offset = segment.data; offset < header.length;) {
    const child = element(offset);
    if (!child || child.id === 0x1f43b675 || !Number.isSafeInteger(child.size)) break;
    const end = child.data + child.size;
    if (end > header.length || end <= offset) break;
    if (child.id === 0x114d9b74) {
      const length = end - offset;
      let width = 1;
      while (length - 1 - width >= 2 ** (7 * width) - 1) width++;
      let size = length - 1 - width;
      const bytes = Buffer.alloc(length);
      bytes[0] = 0xec;
      for (let i = width; i > 0; i--) { bytes[i] = size % 256; size = Math.floor(size / 256); }
      bytes[1] |= 1 << (8 - width);
      patches.push({ offset, bytes });
    }
    offset = end;
  }
  return patches;
}
