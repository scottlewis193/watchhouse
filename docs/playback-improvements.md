# Playback improvements — 18 September 2026

The implementation follows the playback experience audit. Release ranking,
source validation, English-audio defaults, resolution, HDR policy, resume
positions and offline-copy preference remain in place.

## Behaviour

- Buffered seeks use the existing media element and session. Unbuffered seeks
  coalesce for 150 ms; paused scrubbing and audio switching remain paused.
  Keyboard range controls retain their native arrow handling. Exact-end seeks
  leave a quarter-second decoding margin.
- Essential status checks retry transient failures with a capped backoff and
  ten-second request timeouts. Preparation and next-episode polls distinguish
  network failure from a terminal job state. Navigation prevents stale checks.
- Waiting events arm a progress watchdog for both direct and cached conversion.
  Stationary timeupdate events and repeated waiting events do not cancel/reset
  it. Established playback has a ten-second deadline; initial media warmup has
  a 45-second deadline. Server setup retains progressive preparation allowances;
  the browser setup request has a 330-second absolute bound. Intentional pause
  suppresses watchdog recovery.
- Fatal HLS network/media failures query session health. Healthy sessions receive
  at most two local load/reattachment attempts, each with a ten-second recovery
  deadline; failed/expired sessions enter the existing bounded replacement path.
  Native media errors do not race the MSE recovery handler. Structured setup
  rejection codes survive NDJSON. Busy conversion/invalid track errors produce a
  useful terminal message rather than downloading a replacement needlessly.
- Progress writes serialize and coalesce the latest snapshot per media key.
  They retry transient failures twice, catch exhausted errors and use keepalive.
  Watched/unwatched updates retain their meaning when newer positions coalesce.
  Responses update only their own progress entry. Pause, pagehide and internal
  navigation request a final save. Unload delivery is still best effort.
  Reactive proxy media objects serialize correctly. A failed server state write
  no longer poisons all subsequent mutations.
- Local diagnostic exports include bounded samples, server milestones, fragment
  events, setup/recovery events, source-to-advance timings and completed rebuffer
  durations, even when playback starts successfully. Credential-shaped fields
  and private absolute URLs are redacted. No remote telemetry was added.
- HLS sessions keep their original completed segments for retry/backward seeking.
  There are at most four HLS sessions; each has an 8 GiB temporary-output quota,
  checked every five seconds. A shared four-converter admission controller covers
  HLS, prepared downloads and text-caption conversion, with a 16-entry queue,
  bounded waits and foreground priority. These are conservative resource bounds,
  not values inferred from a production capacity study.
- On Unix, FFmpeg is suspended while the viewer is paused or conversion is at
  least 90 seconds ahead. Five-second heartbeats resume conversion when needed.
  Cleanup resumes a suspended child before terminating it. Windows retains the
  storage/admission limits but does not use Unix process suspension. Archive
  extraction/cache retention keep their existing policy.
- Transcoded HLS segments now target two seconds with matching keyframe spacing;
  remux sessions retain four seconds. Ordinary forward/back buffers stay at
  30 seconds, with a 60-second maximum target. Data-saving or <=2 GiB reported
  device-memory clients use 15 seconds with a 30-second maximum target. hls.js
  byte targets are not hard browser memory quotas.
- Established buffering has a delayed status label. Preparation can be canceled;
  unfinished jobs arriving after navigation are also canceled. Where an offline
  copy is already available, buffering offers that copy. Audio choices preserve
  source stream indices and validate the selected track's opening timeline.
- Text captions from local/completed sources convert to WebVTT with a bounded
  child and output limit. Embedded captions become available after download;
  cues shift correctly when the HLS session starts at a saved/seek offset. Image
  subtitles require OCR and are shown as unsupported. Completed converted copies
  can expose only tracks their prepared file retained. No OCR or additional
  adaptive quality renditions were introduced.
- Picture-in-picture is offered where supported, fullscreen has a native iOS
  fallback, and unsupported controls report a dismissible message. Extra controls
  wrap on narrow layouts rather than forcing horizontal overflow.

## Segment measurement

`node scripts/measure-hls-segments.js` generates an isolated eight-second
640 × 360 SDR/AAC fixture, alternates two/four-second trial order and performs
three runs per configuration. It reads no provider/settings/history/cache data.

| Mode | Four-second first segment | Two-second first segment | Output size |
| --- | --- | --- | --- |
| Remux | 37–38 ms | 37–42 ms | effectively unchanged |
| Transcode | 167–173 ms | 109–115 ms | +1.3% for two seconds |

Both retained audio and source dimensions. Two-second segments double segment
request count. These unpaced local results justify a modest transcode startup
experiment; they do not predict live-provider or 4K/HDR latency. Decoded output
and timestamps are checked against accurate-seek/pacing baselines in the real
media regression suite. Tests explicitly select segment zero when FFmpeg reads
an unfinished EVENT playlist; production already serves EXT-X-START at zero.

## Verification and remaining measurement

The regression suite covers buffered/unbuffered seeking, pause intent, stationary
and repeated waiting events, status failures, fallback/episode handover,
progress-write races/retries/proxies, same-session HLS retry budgets, resource
admission/quota/paused cleanup, source/audio validation, and real audio/caption
conversion. A production build runs in an isolated temporary copy to avoid
reloading an existing local playback session.

Browser checks use generated media and mocked APIs, including a deliberately
failed first status request. No provider traffic or real viewing-history writes
are involved. Local diagnostics support repeated measurement using the existing
`scripts/measure-playback-startup.js`; compare cold/warm caches, direct/remux,
SDR/HDR conversion, growing/completed archives, long resumes and concurrent
viewers separately at fixed offsets and quality. A whole-episode production
endurance run, capacity tuning and matched live-provider percentile measurements
remain unmeasured; these changes should not be described as eliminating every
stall or making every cold 4K resume instant.

Final checks: the full suite passed **303 tests**, with no failures or skips.
The production build passed. The additional HLS cleanup rerun passed all 13
cases. Browser checks confirmed a single source for buffered paused rewind,
continued polling after a 503, successful position writes, paused audio switching,
caption loading, a 390-pixel layout without horizontal overflow, and fullscreen
entry/exit. Picture-in-picture was rejected by the in-app browser; the dismissible
unsupported message was verified, so successful PiP on other browsers remains
unverified. These checks are distinct from production endurance testing.


Frame interpolation is an optional Playback setting, disabled by default. New
playback sessions can use motion-compensated intermediate frames at 60 FPS via
[FFmpeg minterpolate](https://ffmpeg.org/ffmpeg-filters.html#minterpolate).
Interpolation forces software processing and can increase buffering and create
motion artefacts. HLS sources already at 60 FPS or above retain their native rate.
Offline copies retain their original frame rate; opted-in viewing of cached
copies uses a fresh conversion session. Preference changes apply on the next
playback start/restart and separate preparation-cache scopes.

Interpolated HLS preparation has a 15-second first-segment budget. If preparation
exceeds that budget or playback stalls, the player disables interpolation for
that episode and restarts once at the current position with native-frame-rate
conversion. The global preference stays enabled for future playback. A visible
message and an `interpolation-fallback` diagnostic event explain the downgrade.
Ordinary bounded recovery remains available if native playback also fails.
