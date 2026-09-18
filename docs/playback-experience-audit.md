# Playback experience audit — 18 September 2026

## Outcome

The highest-value next work is to preserve playback sessions during buffered
seeks, make status checking survive transient failures, and detect stalls from
actual progress. These are concrete control-flow gaps. More cache tuning should
follow measurements of the remaining slow paths.

This assessment changes no playback behaviour. It combines source inspection,
existing regression tests, controlled execution of actual Svelte page handlers,
and a read-only snapshot of the existing local browser player. It is not a
whole-episode endurance test or a production performance benchmark.

## Evidence and existing strengths

The system already has ranked release selection, source and timeline checks,
English-audio selection, progressive archives, persistent source caches,
connection pooling, source reuse, initial encoding bursts, revision-based
readiness notification, bounded direct-stream retries and automatic fallback.
Avoid weakening these safeguards simply to improve a startup number.

Earlier measurements in `docs/playback-performance.md` include cold direct
resumes around 6.8–7.0 seconds and much faster warm starts. Archive cases were
substantially slower. The latest converter-only Matroska experiment produced
a segment at a 410.6-second offset in 2.31 seconds, but its live browser
verification remained outstanding. These are historical observations, not new
results from this audit or interchangeable benchmarks.

The existing localhost Friday Night Dinner player was paused with readyState 4,
no media error, a 1920 × 1080 frame size and approximately 33.6 seconds buffered
ahead. Its media-element position was 22.406 seconds; stream-relative time and
the episode UI timeline can differ. Frame-quality counters were unavailable
through this browser inspection. Playback was left untouched.

## Prioritised improvements

| Priority | Improvement | Expected benefit | Evidence |
| --- | --- | --- | --- |
| P1 | Keep the current source for buffered seeks; preserve pause intent | Faster rewind/skip, fewer converter starts, predictable paused scrubbing | Actual handler probe |
| P1 | Retry status checks with bounded backoff | Recovery UI continues tracking server fallback after a network hiccup | Actual handler probe |
| P1 | Base stall detection on advancing media time or frames | Frozen playback cannot disable its own watchdog with stationary events | Actual handler probe |
| P2 | Recover according to failure type and session health | Avoid needless source replacement and expensive fallback | Source inspection; needs fault tests |
| P2 | Make progress saving resilient and flush the latest position | More dependable resume after navigation or connection loss | Source inspection; needs fault tests |
| P2 | Export a complete, bounded diagnostic session | Explain slow starts and stalls without losing their server context | Source inspection |
| P2 | Bound conversion and temporary HLS resource use | Prevent paused sessions and concurrent viewers consuming excess disk/compute | Architectural risk; pressure not measured |
| P3 | Tune startup segments and buffer targets from measurements | Reduce initial delay and improve tolerance of variable throughput | Experiment required |
| P3 | Improve buffering feedback and viewing controls | Clearer waiting states and more accessible playback | UI/source assessment |

### 1. Buffered seeking and pause intent

`seekToPosition` in `src/routes/watch/[type]/[id]/+page.svelte:789` changes
`resumeStreamOffset` for every `direct` or `cached-convert` seek. The source
action keys its lifecycle on that offset, so it tears down the previous source
and POSTs for another HLS session. It also schedules `player.play()` even if
the viewer was paused.

A controlled fixture used offset 100, media time 20 and a buffered interval
0–60. Seeking to episode time 130 was already buffered, yet triggered one
warmup, changed the offset to 130, left media time at 20 and scheduled playback.

First translate the episode target into the current session's media time.
Use `video.currentTime` when the target is buffered, with a small boundary
margin. Rebuild only for targets requiring another session. Preserve intended
playing/paused state through both paths, and coalesce rapid repeated seeks.

Acceptance: a buffered rewind starts no new HLS session; paused scrubbing
stays paused; an out-of-range seek reaches the correct absolute position;
rapid seeks settle on the final target without stale playback.

### 2. Status checking survives transient failures

`refreshDiagnostics` at page line 271 performs essential job-state tracking
even when detailed diagnostics are disabled. Its next timer is scheduled only
after a successful ready response; the empty catch stops the loop on failure.
A rejected GET in the actual handler scheduled zero further checks.

Reschedule for the current job after transient errors, with a capped backoff
and request timeout. Keep generation checks and avoid rescheduling after a
terminal state or navigation. Apply the same distinction between transient
network failure and terminal job failure to preparation and next-episode polls.

Acceptance: fail one status GET, then make the server return downloading;
the page must leave stale ready state, preserve its position and track recovery.

### 3. Stall watchdog measures progress

`handleStartupBuffering` at page line 525 arms a ten-second watchdog after
established direct playback. `handleTimeUpdate` at line 705 clears it
unconditionally. Running that handler at an unchanged media time cleared an
armed watchdog. Whether this event sequence causes a real browser stall still
needs browser fault injection; the cancellation behaviour is demonstrated.

Track the last meaningful media-time/frame advance with a monotonic clock.
Only progress should reset the deadline. Exclude intentional pause and handle
seek/startup with separate bounded deadlines. Currently initial warmup returns
before arming this established-playback watchdog, and cached conversion has no
equivalent page-level buffering timeout.

Acceptance: repeated stationary timeupdate events cannot postpone recovery;
pause never triggers recovery; genuine advancing playback does not restart;
initial and cached-convert stalls reach a useful bounded outcome.

### 4. Recovery should retain healthy work

`src/lib/hls-playback.js:49` forwards all fatal HLS failures to the same page
interruption path. Direct playback retries replace the converter session up to
three times before automatic fallback. hls.js already retries nonfatal loads;
the missing distinction is what happens after a fatal outcome.

Retain the HLS error type, HTTP status, session identity and server producer
state. Consider bounded same-session network restart or media reattachment
when the source and producer remain healthy. Replace the session for producer
failure, expiry or invalid data; fall back when the selected source cannot
continue. Avoid adding a second uncontrolled retry loop. The official
[hls.js recovery API](https://hlsjs.video-dev.org/api-docs/hls.js.hls.recovermediaerror)
provides media reattachment; it is not a remedy for corrupted source data.

Streaming preparation errors also lose structured identity: the server emits
only `error.message`, and `readPlaybackSetup` throws a plain Error. Preserve
error codes across NDJSON so `SOURCE_UNAVAILABLE` can reach the existing
specialised recovery branch without unnecessary retries.

### 5. Reliable resume writes

`savePlaybackProgress` at page line 463 drops a forced save while another write
is pending and lets rejected writes escape its frequent fire-and-forget callers.
Unmount uses an ordinary PUT rather than an explicit lifecycle-safe flush.

Keep a latest-position queue scoped to the media identity. Catch transient
failures, retry with bounds, and flush the newest position after an in-flight
write finishes. Add a small keepalive/pagehide flush without overwriting watched
state. Ensure a response for a previous episode cannot publish stale progress.

Acceptance: delay a write, pause or navigate, and verify the final position is
stored; fail a write and recover without an unhandled rejection or wrong-episode
update. An unload flush improves best-effort persistence, not a guarantee.

### 6. Diagnostics and resource controls

The downloadable report in `src/lib/PlaybackDiagnostics.svelte:5` contains only
interruptions, despite the UI separately showing server milestones. Its button
is disabled until an interruption exists, so slow successful starts cannot be
exported. Export bounded startup/seek timings, server milestones, session mode,
converter progress, buffer levels, HLS request outcomes and recovery results.
Retain nonfatal HLS failures in a bounded ring and redact credentials/private
URLs. Keep basic measurements local; remote telemetry is a separate decision.

HLS uses four-second target segments, an EVENT playlist and retained segment
files for the session (`src/lib/server/hls-session.js:6`). Heartbeats keep the
session alive while paused. Production can consequently run through a long
title and retain its output. The inspected HLS creation path has no explicit
global encoder admission limit or session-byte quota. Measure this before
choosing a cap; prioritise foreground playback and define pause/retention policy
while preserving backward seeking and active consumers.

The timeupdate handler also rebuilds ranges and performs several checks on every
event. Throttle diagnostics and expensive ancillary work before changing the
timeline controls. Browser event frequency varies with load; see
[MDN's timeupdate documentation](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/timeupdate_event).
No main-thread bottleneck was measured here.

### 7. Measured performance and UX experiments

Benchmark direct/remux, SDR/HDR conversion, growing/completed archives, cold
and warm caches, long resumes, buffered/unbuffered seeks, provider outages,
concurrent viewers and paused sessions separately. Compare at fixed offsets
and quality. Record click-to-first-advancing-frame, seek-to-advance, rebuffer
count/duration, recovery success/time, output speed, CPU/GPU and temporary bytes.
Use distributions and repeated runs, not a single fastest observation.

Test a shorter initial segment and suitable keyframe placement against startup
delay, encoding cost and request overhead. Four seconds is a target rather than
a guaranteed remux segment duration. Tune forward buffers using actual media
bitrate and memory pressure; a larger buffer alone cannot fix sustained delivery
below playback rate. An adaptive quality ladder would be a separate product and
resource decision: the inspected session emits one rendition.

Show a delayed, non-intrusive buffering/recovery label during established
playback, with preserved position and a clear cancellation path for long
preparation. Offer “Use downloaded copy” where appropriate. Follow with captions,
audio-track selection, picture-in-picture and mobile/fullscreen coverage.
The HLS path currently selects one audio track and downmixes to stereo; richer
audio/captions need pipeline work as well as controls.

## Validation performed

- Targeted existing files: hls-playback, playback-pause,
  automatic-playback-recovery, buffered-playback, playback-preflight,
  playback-setup, playback-timeline and next-episode-autoplay. All passed across
  the initial run and preflight rerun. Preflight's first failure was loopback
  EPERM in the sandbox; its authorised rerun passed all five cases.
- Controlled execution of the real page handlers demonstrated buffered-seek
  rebuild/auto-play scheduling, stopped polling after a transient failure and
  watchdog clearing without media-time advance. No playback implementation was
  changed and no failing regression tests were added in this analysis pass.
- Read-only browser DOM/media inspection; no play, seek, navigation, settings or
  viewing-history changes.

Implement the first three items with regression tests at the real handler/source
boundary, then run browser fault-injection checks. Follow with failure-aware
recovery, progress persistence and richer diagnostics before making new live
startup or endurance claims.
