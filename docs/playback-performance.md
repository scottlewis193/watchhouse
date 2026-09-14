# Playback startup optimisation — 14 September 2026

## Scope and measurements

Preserve release-quality ordering, English-audio selection, exact resume position,
provider availability checks, timeline validation, recovery, offline playback,
and background-download behaviour.

Slow Horses S01E02 was tested from its Continue Watching poster at the saved
48.484755-second position. Timings end once video is advancing, unpaused, has
readyState >= 3, and has decoded multiple frames. Test requests intercepted
progress writes; the stored position and timestamp remained unchanged.

An isolated Vite server on port 5189 was restarted with the browser away from
the watch page to measure empty in-memory playback caches. Cold runs also
checked that no existing playback plan was reused. Persistent settings,
catalogue data and release-health records were retained. These are local
observations against a live provider, not a latency guarantee.

| Observation | Time |
| --- | ---: |
| Prior cold-start observations | 11.2–18.3 seconds |
| Cold run during this pass | 9.7 seconds |
| Final cold run with all changes | 11.7 seconds |
| Final warm resume | 1.8 seconds |
| Previous warm resume | 4.3 seconds |

The final stream continued for more than 100 seconds with readyState 4,
2,672 decoded frames and zero dropped frames observed.

## Changes and evidence

- **Use available connections:** new article requests choose the shortest
  connection queue instead of waiting behind a slow article while another
  connection is idle. The regression previously timed out at 200 ms and now
  completes without releasing the blocked article. Connection-count limits
  and retry budgets are unchanged.
- **Share in-flight downloads:** overlapping range servers for the same source
  reuse an article already being downloaded. The regression went from two
  provider reads to one. Failed downloads are removed so later attempts retry;
  different source objects remain isolated. The completed-byte budget is still
  64 MB globally.
- **Reuse the header connection:** availability sampling retains its already
  authenticated connection for subsequent samples. The two-lane fixture now
  opens two connections instead of three, and single-article cleanup is tested.
- **Accelerate the initial HLS buffer:** where supported, FFmpeg can read the
  initial eight seconds without the steady-state input throttle, then retain
  the existing 1.5x pace. Codec, quality, audio mapping, segment and keyframe
  settings stay the same. The fixture failed the 1.8-second startup budget at
  2,949 ms before the change and passes afterwards. Decoded video frames are
  compared with conversion using the previous pace, and audio remains present.
- **Overlap catalogue requests:** an explicitly requested season's episodes
  load alongside the season list. In-flight requests are shared. Season and
  episode validation, fallback selection and offline paths remain in place.
- **Initialise already-ready sessions once:** the page sets the saved offset
  before mounting the player. The browser fixture changed from stream starts
  at `[0, 48]` plus one redundant status request to `[48]` with no status request.

FFmpeg capability detection runs once and falls back to existing pacing if the
option is unavailable or detection fails. Local measurements used FFmpeg
n9.0.1. Older packaged versions do not receive the startup-burst benefit.
The option's behaviour is described in the
[FFmpeg input pacing documentation](https://ffmpeg.org/ffmpeg.html#Advanced-options).

## Verification

- `npm test`: 157 passed, zero failed or skipped on the local environment.
- `npm run build`: passed.
- Browser fixture: open the local app, then run
  `playwright-cli -s=<session> run-code --filename=scripts/check-playback-startup.js`.
  Expected: `passed: true`, overlapping episode loading, zero initial status
  polls, and one stream start at 48 seconds. This fixture mocks API responses
  and finishes on a blank page; it does not update saved viewing history.
- `git diff --check`: passed; no temporary debug instrumentation remains.

## Initial stopping point

The remaining cold-start work includes live indexer/provider responses, reading
and validating source data, selecting audio, seeking and encoding the first
segment. These checks still run in full. A synthetic test processed 16 MB
through the NNTP line reader and yEnc decoder in 91 ms; a parser rewrite was
not justified by that result.

No further behaviour-preserving improvement was established in this pass.
This is not a proof of global optimality. Reducing validation, selecting a
lower-quality release, retaining playback decisions across restarts with new
expiry rules, or speculative preparation before a click would require separate
behaviour/resource-policy decisions and were not introduced.

## Follow-up: the seven approved improvements

Implemented after approval to change cache retention and speculative resource
use, while preserving release ranking, video quality, audio selection, resume
position, validation, recovery and offline playback.

- **Authenticated connection pool:** foreground readers lease a connection per
  complete article/command. Real connections obey the configured shared provider
  limit; idle connections expire after five seconds (one second with background
  downloading enabled). Background transfers release idle pooled sockets before
  connecting. Failed/partial reads discard their connection. Cancelling a reader
  also interrupts a pending connection or login.
- **Overlapping candidate checks:** retain the three-NZB lookahead and overlap at
  most two direct-file availability checks. Results are consumed in ranking
  order. Background and single-connection checking remain serial, and unused
  checks are cancelled.
- **Validation/encoding overlap:** identify the audio stream first, then encode
  while checking the full opening 20-second timeline. A session is returned only
  after validation succeeds. Rejected speculative output is discarded before
  recovery. Cancelled probes cannot poison a later foreground attempt.
- **Readiness notification:** a revision-based held request wakes when preparation
  changes, removing the polling delay. Requests end after 15 seconds; the browser
  applies a 20-second timeout and falls back to ordinary polling on failure.
- **Persistent source plans and probes:** retain up to 100 metadata records, using
  the existing cache-retention setting (24 hours by default). Provider/account,
  indexer, quality, manual-selection mode and audio-policy changes invalidate
  reuse. A restored plan checks the first and last articles live before reuse;
  a stale source falls back to normal selection. A previously selected release
  can remain preferred until expiry, even if a better release appears meanwhile.
- **Persistent validated source bytes:** a global 512 MiB disk budget retains
  recently accessed articles, with bounded queued writes and SHA-256 integrity
  checks. Corrupt/missing cache data falls back to the provider. Retention follows
  the existing cache setting. Hits depend on the needed bytes remaining in this
  rolling cache; converted HLS assets remain scoped to their player session.
- **Continue Watching preparation:** 350 ms of mouse hover or keyboard focus can
  prepare one title's release, validation and roughly eight seconds around its
  saved position. It never downloads/extracts an archive or starts playback.
  Work stops after a 20-second budget and expires after five minutes; another
  poster replaces it and an actual Play request either takes ownership or cancels
  it. Active playback, offline copies, manual release selection, touch scrolling
  and the browser's data-saving preference suppress speculative preparation.
  Hovering may therefore use provider bandwidth even without a subsequent click.

### Observed timings

These runs used an isolated local server on port 5189. The saved position was
65.030076 seconds; the earlier measurements above used 48.484755 seconds, so
these are not a matched statistical before/after comparison. The provider is
live and response times vary.

| Scenario | Click to advancing video |
| --- | ---: |
| Empty playback memory and disk cache, poster preparation disabled | 9.048 s |
| Repeat resume with memory cache | 1.758 s |
| Server restart, retaining disk cache, poster preparation disabled | 2.678 s |
| Repeat restart check after cancellation hardening | 2.706 s |
| Initially empty cache, then 15 seconds hovering before clicking | 1.245 s |

The hover wait is **additional time before the click**, not part of the 1.245 s
measurement. Logs confirm actual persisted-plan and poster-preparation hits.
Catalogue cache files and existing release-health history were retained for the
cold measurements. Cache directories were isolated via
`WATCHHOUSE_PLAYBACK_CACHE_ROOT`; no user cache was cleared. Viewing-history
writes were intercepted, and the real saved position/timestamp were unchanged.

A sustained run reached 100.019 seconds of video with readyState 4, 2,402 decoded
frames and zero dropped frames observed. Full regression tests and a production
build pass. The browser fixture also verifies one stream starts at the saved
48-second fixture position, with overlapping episode loading and no redundant
initial status poll.

Reproduction helper: `scripts/measure-playback-startup.js`, run using
`playwright-cli run-code --filename=...` on the isolated server. Starting from
`about:blank` targets localhost:5189 with poster preparation disabled; starting
from `about:blank#benchmark=prewarm` enables the 15-second hover case. Restart the
server with the same isolated cache to test persistence, or a fresh directory
for a genuinely cold playback cache. Preserve catalogue cache files when making
comparisons with the measurements above.

## Empty-playback-cache follow-up

A further pass focused on work performed **after clicking Play**, with poster
preparation disabled and a new playback cache directory for each cold run.

Changes:

- Start preparation for a saved, explicitly requested Continue Watching resume
  while catalogue requests finish. Settings must have loaded successfully and
  manual selection must be off. The same season/episode validation still gates
  the player, and the prepared job is consumed only for the matching title and
  episode. A browser fixture verifies overlap, one stream at the saved offset,
  preservation of manual selection, and refusal to play an invalid catalogue
  selection.
- Keep the three NZB HTTP slots working independently of the two availability
  checks, using a bounded six-candidate lookahead. Consume results in quality
  order and cancel unused work. Background preparation remains serial. The
  regression previously stalled before loading the sixth candidate while the
  first checks were pending; it now passes without exceeding three HTTP loads.
- Open one authenticated provider connection alongside discovery. Keep this
  unused connection available for up to five seconds; normal article reads
  retain their existing idle policy, and background work can reclaim idle
  sockets. Connection limits, authentication and retry behaviour are preserved.
- Match range read-ahead to the loader's actual concurrency. With the configured
  50-connection limit, the old range code queued 50 articles behind 12 lanes.
  Abandoned ranges consequently delayed new seek requests behind several batches
  of unwanted downloads. The regression now reaches the seek after the active
  batch, without changing the user's connection setting or video data.

Playback diagnostics now record source metadata, timeline validation, encoding
and first-segment readiness milestones. The measurement script includes those
stages when diagnostics are enabled.

| Observation | Click to advancing video |
| --- | ---: |
| Fresh baseline before this pass | 11.458 s |
| Isolated run before the range read-ahead fix | 7.329 s |
| Final cold run A | 6.770 s |
| Final cold run B | 7.004 s |

All these measurements resumed Slow Horses S01E02 from the same saved
77.919723-second position. They used fresh playback memory and disk caches,
retaining catalogue files and release-health history. The final timings ran
without a concurrent test/build workload. An intermediate run with the test
suite active was excluded from the comparison. Live provider timings vary, so
these observations are not a guaranteed latency or a statistical benchmark.

In final run A, source selection finished 3.771 seconds after the job was created,
timeline validation finished at 4.700 seconds, and the first HLS segment was
ready at 6.003 seconds. The full opening timeline check was retained. Final run B
continued to 100.015 seconds of video with readyState 4, 2,402 decoded frames and
zero dropped frames. Viewing-history writes were intercepted throughout.

Final validation: all 177 regression tests pass, and the production build succeeds.

## First play without saved progress

The earlier catalogue overlap was limited to saved resumes. An explicitly
requested first play therefore waited for catalogue loading before starting
source selection. Preparation now also starts for an explicit movie or a TV
link with positive season and episode numbers, once settings have loaded.
Manual selection still opens the chooser; catalogue validation still gates
player startup; the prepared job is reused only for the matching media key.
Starting from zero remains independent of any saved resume offset. General
show links without a specific episode still resolve which episode to play first.

The browser regression `scripts/check-playback-startup.js` now supports
`?startup=first` on its initial app URL. With no progress and a delayed episode
response, it failed before the change (`playOverlapped: false`) and passes after
it (`playOverlapped: true`, one stream starting at zero). The saved-resume mode
also passes, retaining its 48-second fixture offset. Both modes verify manual
selection and invalid-catalogue handling.

Fresh playback-cache S01E01 measurements, navigating directly to the explicit
play URL with progress absent from browser state and poster prewarming disabled:

| Observation | Navigation to advancing video |
| --- | ---: |
| Before extending the overlap | 6.549 s |
| After, run A | 9.080 s |
| After, run B | 6.019 s |

These runs retain catalogue caches and release-health history. Provider timing
varies: source selection took 3.576, 5.031 and 3.352 seconds respectively.
Opening validation finished 1.579, 2.821 and 1.438 seconds after encoding started.
The deterministic regression proves removal of the catalogue dependency; these
few live runs do not establish a consistent overall latency reduction. Full
opening validation, quality ordering and audio selection are unchanged. History
writes were intercepted and stored progress remained unchanged in every run.

The measurement helper supports `?benchmark=first` on its initial app URL to
repeat this no-progress scenario. All 177 regression tests, both browser fixture
modes, and the production build pass.
