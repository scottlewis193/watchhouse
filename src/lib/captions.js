const seconds = value => value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
const timestamp = value => {
  const ms = Math.max(0, Math.round(value * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
export function captionsAtOffset(text, offset = 0) {
  if (!/^WEBVTT(?:\s|$)/.test(text.replace(/^\uFEFF/, ''))) throw new Error('Choose a WebVTT (.vtt) caption file.');
  return text.split(/\r?\n\r?\n/).flatMap(block => {
    const match = block.match(/((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})/);
    if (!match) return [block];
    if (seconds(match[2]) <= offset) return [];
    return [block.replace(match[0], `${timestamp(seconds(match[1]) - offset)} --> ${timestamp(seconds(match[2]) - offset)}`)];
  }).join('\n\n');
}
