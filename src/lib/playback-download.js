function bytes(value) {
  let amount = Math.max(0, Number(value) || 0), unit = 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

export function playbackDownloadProgress(download) {
  const total = Number(download?.totalSegments), completed = Number(download?.completedSegments) || 0;
  const percent = Number.isFinite(total) && total > 0 ? Math.round(Math.min(1, Math.max(0, completed / total)) * 100) : null;
  const details = [`${bytes(download?.bytes)} downloaded`];
  const speed = Number(download?.bytesPerSecond);
  details.push(Number.isFinite(speed) && speed > 0 ? `${bytes(speed)}/s` : 'Measuring speed…');
  const remaining = Number(download?.remainingSeconds);
  if (Number.isFinite(remaining) && remaining > 0) {
    const seconds = Math.ceil(remaining);
    details.push(`about ${seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${seconds}s`} left`);
  }
  return { percent, detail: details.join(' · ') };
}

export function playbackPreparationStage(status) {
  if (status === 'downloading') return { title: 'Downloading video', message: 'A full download is needed before playback can start.' };
  if (status === 'extracting') return { title: 'Unpacking video', message: 'Download complete. Unpacking the video before playback…' };
  if (status === 'optimizing') return { title: 'Preparing video', message: 'Download complete. Getting the video ready to play…' };
  return null;
}
