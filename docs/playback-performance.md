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

## Archive download queue and disk writes

Archive volumes now share one article queue instead of completing each volume
before starting the next. A separate serial assembly queue overlaps disk copying
with subsequent downloads. Article output is batched into 64 KiB writes, and
existing completed parts are discovered with one directory listing per volume
rather than a failed stat call for every missing article. Completed parts remain
available for retries; pending articles and partially assembled volumes are not
published as complete. Cancellation and download/assembly failures close readers
and wait for workers before returning to caller cleanup. Duplicate normalized
volume filenames retain the previous first-file-wins behaviour.

Foreground work retains the 12-worker ceiling and configured provider limit;
background work retains one worker. Archive extraction and playback validation
still run after downloading. This change does not implement progressive archive
playback or eliminate the final volume-copy pass.

Live measurements used identical prefixes of three Silo S01E01 NTb split-7z
volumes: 16 articles per volume, 48 articles / 34,406,400 decoded bytes per run.
Each run used a fresh process and temporary output directory. SHA-256 hashes of
all three outputs matched the previous downloader in every run. No full episode
was downloaded. No test suite or build ran concurrently with these measurements.

| Downloader | Worker ceiling | Seconds | MB/s (decimal) |
| --- | ---: | ---: | ---: |
| Previous serial volumes | 12 | 3.159 | 10.89 |
| Shared queue | 12 | 2.485 | 13.85 |
| Shared queue | 24 | 3.152 | 10.92 |
| Shared queue | 50 | 3.034 | 11.34 |
| Shared queue, repeat | 12 | 2.662 | 12.92 |
| Previous serial volumes, repeat | 12 | 2.645 | 13.01 |

The initial gain did not repeat consistently; these short provider-dependent
samples do not establish a sustained throughput improvement. Higher concurrency
was not beneficial in these samples, so the production ceiling remains 12.
Deterministic regressions confirm that a slow article in one volume no longer
leaves another worker idle and that assembly no longer blocks network progress.
Tests also cover byte order, batched writes, reuse of completed parts, partial
write cleanup, cancellation, missing articles, assembly failures, duplicate
filenames, and actual split-7z extraction yielding the original input bytes.

Final validation: 189 tests pass and the production build succeeds.

## Progressive archive playback

Foreground archive selection now tries progressive extraction in ranking order
before full-download candidates. Supported regular split 7z/RAR sets and single
ZIP archives are exposed as a virtual byte-range input. Only the first and last
volume headers are needed to establish regular volume sizes; each fetched yEnc
article is validated against its expected byte offsets and length. Irregular or
unsupported layouts retain the complete-download fallback.

A Python 3 helper uses the system libarchive reader with read/skip/seek callbacks.
It fetches metadata using small reads, selects the largest regular video entry,
and then extracts into a growing file. The video range server waits for requested
bytes rather than serving sparse zeroes or premature EOF. Metadata and the full
opening audio/video timeline are checked before HLS startup. While extraction is
incomplete, FFprobe and FFmpeg avoid unnecessary tail seeks; resume uses decoding
from the beginning to the requested offset. Seeking beyond extracted data can
therefore take longer. Completed extraction allows ordinary byte-range seeking.

The extraction process and provider readers close when an unclaimed source
expires (30 seconds), or five seconds after its last playback lease is released.
Idle cleanup removes the extracted temporary video. Native decompressor memory
is bounded to 1 GiB where the host supports resource limits. The Docker build and
runtime include Python 3 and libarchive, and copy the helper into the image.

Unsupported reader/layout cases fall back to the existing full-download route.
Known encrypted archives and missing required archive articles are skipped,
since this application has neither archive passwords nor parity repair. The
existing extractor is also invoked without an interactive password prompt.
Full-file CRC failures detected after playback begins fail the progressive source;
progressive playback cannot promise whole-file verification before the first frame.
Offline and next-episode downloads retain complete-file preparation.

Validation uses real archives and FFmpeg:

- The beginning of a 7z video is readable with the middle of its archive held
  behind a test gate; suffix reads match the original after completion.
- Actual HLS segments become ready before extraction finishes, with the opening
  timeline validated. A 10-second resume also starts before the archive completes.
- Eliminating unnecessary tail seeks reduced the initial HLS test's total runtime
  from about 16.1 to 2.6 seconds before the resume scenario was added. These are
  local fixture timings, not provider or browser startup benchmarks.
- Compressed 7z selects the main video over a smaller sample; multivolume stored
  RAR extraction matches the original bytes and validates its CRC.
- Tests cover numeric volume ordering, cross-volume yEnc ranges, late CRC errors,
  encrypted-header rejection, abandoned-process cleanup, progressive-first release
  selection, and recovery without an unexpected full download.

Initial Silo S01E01 verification (later found to cover truncated search results;
see the correction below) found that the preferred NTb 97-volume 7z archive
has an encrypted header. The FW and SpK79 archive candidates returned missing
required articles. The integrated selection probe rejected all three in 2.276
seconds and started zero full downloads. Progressive playback cannot make those
current provider results playable. Inspection used temporary data and did not
change viewing history.

Implementation references: [libarchive callback I/O](https://github.com/libarchive/libarchive/wiki/LibarchiveIO)
and [the upstream RAR reader](https://github.com/libarchive/libarchive/blob/master/libarchive/archive_read_support_format_rar.c).

Final validation: all 203 tests pass, including progressive HLS startup and resume, and the production build succeeds. The Docker image itself has not been built in this validation run.


## Silo search coverage correction

The earlier conclusion that Silo S01E01 had no usable release was too broad.
The shared XML parser silently kept only 24 results, even when an inspection
requested 100. The indexer actually returned 415 results across five pages;
114 passed the existing title/audio filters, compared with 15 previously.

Release discovery now retains all returned items and follows result pages up to
500 items per title variant. It stops on repeated pages, honours cancellation,
and preserves earlier results if a later request fails. NZB and provider checks
retain their existing bounded concurrency. The generic search display keeps its
24-item presentation limit explicitly, outside the shared parser.

Rejection records now identify individual uploads using a hash of their NZB URL
(without the API key), rather than their display title. Saved plans carry that
identity into recovery. A broken upload therefore does not blacklist another
upload with the same title. Old title-only rejection records are not applied to
new upload identities, so some previously rejected sources will be checked once
again. No NZB URLs or credentials are added to saved plans or diagnostics.

Live verification of the corrected discovery function returned 114 candidates
in 1.869 seconds and included both of these previously omitted sources:

- `Silo.S01E01.480p.x264-mSD`: opening metadata and audio/video timeline validated
  in 7.945 seconds, with 4 MiB extracted out of 439,590,729 video bytes.
- `Silo.S01e01.2160P.Atvp.Web-Dl.Ddp5.1.Atmos.Dv.Hdr.H.265-Flux`: the same checks
  passed in 10.547 seconds, with 4 MiB extracted out of 607,225,906 video bytes.

Both were still extracting when validation completed. These are upload labels
and isolated source-validation measurements, not verified resolutions, browser
startup timings, or complete-episode integrity checks. The inspection did not
start a full download or change viewing history.

Regression tests reproduce the old item-24 cutoff and same-title blacklist bug,
and cover pagination, provider page caps, repeated pages, request bounds, partial
failure and cancellation. All 212 tests pass and the production build succeeds.

### Progressive archive resume pacing (2026-09-14)

A live Silo S01E01 conversion resumed at 110.900803 seconds using output-side
seeking against an incomplete archive. Input pacing still allowed only an
eight-second initial burst, so FFmpeg throttled the footage it had to discard
before producing any playable output. At 1.5x this imposed roughly a minute of
unnecessary waiting and could exceed the 45-second HLS readiness deadline.

HLS preparation now includes the discarded input duration in the initial burst
only when the archive is incomplete and requires output-side seeking. At this
resume point the allowance is 118.900803 seconds. Retained video keeps the usual
eight-second startup allowance and 1.5x input pacing. Direct and completed-file
input seeking keep their ordinary allowance. Capability detection remains cached,
with separate arguments per request. Older FFmpeg builds without
`readrate_initial_burst`, or failed capability checks, retain compatible 1.5x
pacing; the slow progressive-resume limitation remains on those builds. We do
not disable pacing and allow unlimited conversion to work around that limitation.

The real archive/HLS integration regression now resumes at 110.900803 seconds in
a 180-second fixture while the archive tail is withheld. Before the fix it failed
the eight-second segment-readiness deadline; after the fix the whole integration
test, including initial playback, timeline validation, resume and cleanup, took
5.1 seconds. Capability tests cover concurrent requests and the older-FFmpeg
fallback. All 213 tests pass and a production build in an isolated temporary copy
succeeds, avoiding generated-file reloads in the running development server.

An isolated provider test of
`Silo.S01E01.Freedom.Day.2160p.ATVP.WEB-DL.DDP5.1.H.265-NTb` then produced its first
HLS segment at the same resume point in 28.783 seconds after archive opening,
including playback inspection and conversion setup. Total cold discovery,
archive opening and resume preparation took 47.057 seconds. Only 297,795,584 of
9,723,950,472 video bytes had been extracted, and extraction was still incomplete.
Explicit session/source cancellation completed in 1.091 seconds, and the
temporary source was closed and removed. Viewing history was not changed.

These are server-side first-segment measurements, not browser playback timings
or evidence that every buffering cause is fixed. Earlier sustained source testing
produced 104 seconds of media during a 60-second observation, without reproducing
the original underrun. The original buffering trigger remains unresolved; the
player's **Playback diagnostics → Download diagnostic report**, captured after a
stall and before navigation/reload, is needed to correlate browser buffers and
recovery with server activity.
