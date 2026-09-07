export function stopConversion(child) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  // FFmpeg may be stuck flushing a pipe or a hardware encoder after SIGTERM.
  const forceStop = setTimeout(() => child.kill('SIGKILL'), 1000);
  forceStop.unref();
  child.once('exit', () => clearTimeout(forceStop));
}
