# Playback startup optimisation — 14 September 2026

## Publishing integration correction (2026-11-13)

The Docker full-suite check exposed four VM-harness failures: extracted recovery
and watchdog handlers referenced `startupReports`, but those harnesses did not
supply it. They now use the real startup reporter with controlled scheduling and
captured reports, matching the page dependency without suppressing diagnostics.
All 41 recovery/watchdog tests passed after the correction.

## Successful-source restart, linear probes and longer Play intent (2026-11-13)

### Changes

- Successful stored-archive manifests now use the existing persisted playback
  plan interface, alongside existing direct/torrent plans. A restart can reopen
  the previously working articles before search or NZB description fetching.
  Fresh provider/header, timeline, first-segment and throughput checks still run.
  A failed saved source is discarded and normal selection resumes. Only fully
  validated stored sources from actual automatic playback are saved; unclaimed
  speculation, manual choices and incomplete/failed sources do not create plans.
- Archive plans bind exact media/episode and playback policy/provider scope, use
  the existing retention window, have a separate global 128-plan limit and store
  checked, checksummed article manifests rather than live source objects.
  Existing title clearing and plan invalidation remove them.
- HTTP Matroska metadata and packet inspection normally reads linearly instead
  of seeking to the tail index and back. Default analysis, all stream metadata
  and the twenty-second opening packet interval remain intact. On non-seekable
  input the interval is `%+20`: explicitly seeking to zero can discard packets
  buffered during analysis, skipping the actual opening. Seek-dependent,
  mislabeled or incomplete-metadata results fall back to the standard probe.
  Cancellation does not trigger another probe. Non-Matroska inputs retain their
  existing seek behavior.
- Explicit Play pointer intent dispatches after a 100 ms crossing guard;
  keyboard focus dispatches next turn and can advance a pending pointer timer.
  The single active, unclaimed intent has a non-renewable 30-second budget
  instead of ten seconds. It may inspect up to three candidates sequentially,
  so an unsupported first upload does not make the longer budget useless.
  Claiming transfers ownership to playback; abandonment or policy changes
  cancel unused work. Ordinary poster hover/render and touch scrolling still
  do not start new-title preparation. Offline, Save-Data and manual-selection
  guards remain; no speculative full download/extraction is enabled.

### Actual browser results

| Title | Source-cold, no Play prewarm | Saved source after server restart | After 20 s explicit Play hover |
| --- | ---: | ---: | ---: |
| Blade Runner 2049 | 25.059 s | 13.069 s | 2.748 s |
| The Shawshank Redemption | 14.326 s | 5.809 s | 0.477 s |
| Lupin S01E04 | 13.611 s | Not tested | Not tested |

Each result is click to decoded, advancing video, followed by three seconds of
continued advancing playback. These are individual live-provider runs, not
latency percentiles or long-playback reliability claims. The hover column
**excludes its intentional twenty seconds before the click** and used a separate
fresh-cache fixture. Both preparations returned `prepared: true` and were claimed
with `poster-preparation-hit` after the previous ten-second deadline.

Restart controls emitted `persistent-archive-plan-hit`, reused layout/metadata,
ran fresh timeline and playback checks, and performed no search. All runs used
the same Best preset and Usenet uploads as the previous controls. Cold results
are not clearly better than the prior 23.779/14.572/13.694-second runs; the
demonstrated gains are saved-source reuse and bounded preparation before Play.
The ten-second target remains unreliable for cold playback.

### Probe experiment and verification

Reducing the archive read window from 8 MiB to 2 MiB fetched fewer decoded bytes
but hurt parallelism: pinned Blade readiness changed 14.019 → 20.833 s and
Shawshank 5.731 → 7.795 s. That experiment was rejected; encoder/bulk windows are
unchanged. Linear inspection removed the tail/return requests: a real HTTP
fixture went from four requests to one while matching standard metadata,
retaining delayed English audio and packets from the opening through 19+ seconds.
It also verifies standard-probe fallback when linear access is refused.
Live pinned-source metadata completion changed 10.903 → 8.979 s and
5.731 → 3.668 s in one series, but full archive headers can still dominate
readiness. Decoded article counters were sampled at layout completion with
asynchronous overfetch potentially in flight; they are not a wire-byte saving
claim.

Checks passed: 54 persistence/selection/intent tests; 47 probe/HLS/progressive/
prewarm-lifetime tests; then 68 selection/prefetch/intent/lifetime tests after
the three-candidate budget change. Production builds passed. New regressions
were observed failing before saved-source integration, linear probing and the
candidate-budget fix. The existing `searchInput` non-reactive-state build warning
remains.

Redacted evidence: `local://three-startup-browser-results.json` and
`local://three-startup-probe-experiments.json`. Watch history stayed unchanged
in every browser run. User settings, media state and release health matched their
initial copies. Owned browser tabs/servers are stopped and private NZBs, fixture
caches and measurement harnesses are removed after measurement.

## Progressive startup contention, reuse and intent handoff (2026-11-13)

This follow-up preserves the configured Best preset, provider connection budget,
timeline validation, opening-segment timestamp checks and playback-speed gate.
It does not make the ten-second click-to-playing target reliable.

### Retained changes

- Stored-archive header inspection now uses at most eight readers, within the
  existing provider headroom and single-reader background limit. More parallel
  header bodies competed with metadata/payload traffic in the measured runs.
- Already validated opening and ending article bytes enter the existing bounded
  resume-segment cache. Entirely cached range reads bypass the serial provider
  reader queue; misses retain its existing eviction and ownership protection.
  Article tracing found **no duplicate opening download**: the demonstrated
  handoff delay was an encoder cache hit queued behind an abandoned 8 MiB probe
  read. This corrects the earlier refetch hypothesis; no additional pinned cache
  or cache budget was needed.
- A range response sends at most 64 KiB in its first chunk before using its normal
  bulk window. Small metadata reads can finish without first fetching that window;
  complete response bytes, range boundaries and backpressure remain covered.
- Validated stored-archive metadata survives restart. Records bind the complete
  manifest, provider/policy scope and validated member layout, with version,
  checksum, existing retention and an independent 128-record bound. Only metadata
  is reused: packet/timeline inspection, first-segment checks and throughput
  validation still run. Incomplete, failed, expired or mismatched sources cannot
  supply a persisted probe; layout/media invalidation removes its records.
- Claiming an explicit Play preparation cancels only its optional extra packet
  warm-up, not the shared validation already in progress. Progressive archives
  already skip that optional work, so this cancellation is not claimed as a speed
  improvement for the archive controls. The existing 350 ms intent debounce,
  ten-second unclaimed budget and offline/Save-Data/manual guards are unchanged.
- A failed volume-header read aborts the byte input's other requests immediately.
  Cancellation preserves the original provider error instead of replacing a
  missing-article diagnosis with a secondary socket/abort error.

### Actual browser results

Times are click to decoded, advancing video, followed by another three seconds
of advancing playback. These are individual live-provider measurements, not
latency percentiles or long-duration playback tests. “Cold” means an unseen source
with Play prewarming disabled, not a fresh provider connection for every title.
The page and catalogue metadata are loaded before the click.

| Title | Source-cold click to playing | After 5 s explicit Play hover | Delivery |
| --- | ---: | ---: | --- |
| Blade Runner 2049 | 23.779 s | 17.849 s | Stored archive, video copy |
| The Shawshank Redemption | 14.572 s | 8.234 s | Stored archive, converted |
| Se7en | 10.368 s | Not tested | Stored archive, converted |
| Pulp Fiction | 10.341 s | Not tested | Posted video, converted |
| Lupin S01E04 | 13.694 s | Not tested | Stored archive, converted |
| The Rookie S01E02 | 7.441 s | Not tested | Posted video, video copy |

The hover column excludes its deliberate five-second dwell; both preparations
returned `prepared: true` and were actually claimed (`poster-preparation-hit`).
These are not cold-start results. A separate Blade restart took **19.021 s**,
with both layout and metadata reuse plus a fresh timeline scan. Previous cold
controls were 24.227 s and 16.004 s respectively; network/indexer variation means
the small cold-control differences are not a reliable per-change speedup estimate.

The four fresh samples were selected before testing with xorshift seed
`0x20261114`, from cached discovery titles dated 1990–2023, excluding prior
controls/samples (8 eligible movies, 152 shows). All four played; none was replaced
with an easier title. All deliveries were Usenet, not torrents.

### Rejected experiments and remaining limits

An adaptive eight-to-sixteen header-reader limit showed no repeatable advantage
in two paired pinned-upload runs and was removed, including its extra phase API.
A browser run with that experiment took **33.877 s** after trying an alternative
Blade upload with a missing article before falling back. That result is retained,
not hidden behind the successful upload's own preflight time. Its trace exposed
the failed-header drain fixed above; the deterministic regression failed before
the fix and passed afterward.

Pinned-source preflight is not browser startup: one Blade series moved from
19.935 s to 14.847 s, and Shawshank from 13.432 s to 7.792 s, but these exclude
search, selection and browser delivery. A Node CPU sample was about 86% idle;
it does not profile FFmpeg/GPU work and does not justify rewriting the decoder.
No further low-risk change demonstrated a repeatable gain in this pass. Missing
articles, search/provider latency, payload/header delivery and the unchanged
validation gates remain material costs.

Verification: 104 focused integration tests passed, along with the 20-test stored
RAR suite and three cache-range regressions. The final 37-test header/progressive/
cache check and production build passed after removing the adaptive experiment
and adding failed-header cancellation. The build retains the pre-existing
`searchInput` non-reactive-state warning.

Redacted evidence: `local://next-startup-results.json`,
`local://next-startup-source-measurements.json` and
`local://next-startup-random-playback.json`. Browser fixtures kept watch history
unchanged; the user's settings, media state and release-health files matched
their initial seed copies. Private NZBs, cache/profiles and benchmark resources
are removed after measurement; no provider credentials or article IDs are kept
in these reports.

## Overlap stored-archive headers with metadata (2026-11-13)

Stored RAR startup no longer serialises every volume header ahead of metadata.
The production caller opts into provisional access to checksummed first/last
volume payloads when their declared member size safely locates both endpoints.
Unknown sizes or unsafe endpoint layouts retain full inspection before opening.
Middle offsets are never inferred: a read reaching an unmapped part waits for
the complete validated mapping. Open-ended requests stream the known prefix
instead of waiting for headers that do not describe those bytes.

The source exposes pending `completion`, `complete: false` and `layout: null`
until every header passes. Metadata and private encoding may overlap inspection,
but HLS sessions and legacy converted responses cannot expose playback before
header completion. Inconsistent layouts reject completion; missing-article errors
are preserved, and close drains outstanding inspection. Persisted layouts still
require full validation; accepted cached layouts retain endpoint-only reuse.
Growing compressed extraction is not gated on full-file completion.

Fresh processes replayed the exact saved NZBs, with unchanged Best quality,
timeline repair, audio/decode checks and deferred full-file CRC verification:

| Source | Preflight before | Preflight after | Cold browser after |
| --- | ---: | ---: | ---: |
| Blade Runner 2049 | 22.9 s | 19.4 s | 24.2 s |
| The Shawshank Redemption | 11.3 s | 10.4 s | 16.0 s |

Preflight measures archive input opening through the existing first-segment,
audio/decode and throughput checks; it excludes release discovery and browser
startup. The browser column measures actual Play click to decoded advancing video,
without Play prewarming, and includes discovery. Both selected the pinned upload
titles and advanced for another three seconds. Blade Runner was visually captured.
Neither cold browser run met ten seconds.

Metadata access became available after 0.92/0.44 seconds rather than waiting
9.74/5.19 seconds for the full layouts. Full inspection still completed before
readiness, at 10.17/6.38 seconds in the after profiles, with at most sixteen active
header readers. Endpoint checks add two cached-header calls, not two new NNTP
downloads. Header inspection and metadata share provider capacity; the longer
full-inspection time and variable live provider latency limit the observed gain.

Verification: the new overlap regression failed before implementation; 55 focused
archive, metadata, HLS and seek tests and the production build passed afterward.
Coverage includes exact prefix/suffix/middle bytes, unknown-size fallback,
invalid/missing middle headers, inspection drainage on close and rejection of
speculatively encoded HLS output. Existing Svelte `searchInput` reactivity warnings
remain unrelated. Settings and watch history were unchanged; isolated credentials,
caches, services, browser tab and temporary profiling files are removed after use.

## Archive filtering, bounded parallelism and persisted layouts (2026-11-13)

Implemented the complete next optimisation set:

- Foreground NZB lookahead reads one bounded first article and classifies its
  checksummed RAR header before opening the whole archive. Header and existing
  STAT work share one admission slot and one 1.5-second deadline. A successful
  body is handed to foreground opening, not downloaded again. Speculation is
  disabled for manual/background/offline work and header lookahead for accounts
  with at most two connections.
- Confirmed encryption and out-of-spec RAR packing methods receive explicit,
  persisted upload/article-set cooldown reasons. Ordinary compressed RAR remains
  supported through extraction; incomplete, unknown and damaged headers remain
  inconclusive. ZIP/7z prefixes are conservative unknowns. Fingerprint rejection
  is published before releasing the lookahead slot, preventing duplicate uploads
  racing ahead of the cooldown write.
- Already-prepared equivalent candidates prefer direct video, then stored RAR,
  then extraction, then unknown packaging. Reordering does not wait for another
  check or cross audio-confidence, preset size, resolution, score or inferred
  playback-strategy preferences. Manual/background selections retain their order.
- Real archive inputs derive rolling header concurrency from the configured
  provider budget, reserving headroom and capping at sixteen readers. The shared
  NNTP pool/coordinator still limits total provider connections. Payload windows
  adapt to article size and usable lanes, bounded between 64 KiB and 8 MiB, with
  HTTP backpressure and cancellation. Extraction and encoding remain single-source.
- Fully validated stored-RAR layouts use the existing owner-only atomic
  `records.json` store, scoped to credentials/settings and the complete ordered
  manifest. Checksummed, versioned records expire under cache retention and are
  bounded to 128 layouts without evicting unrelated metadata/plans. Reuse checks
  structure, volume offsets and both endpoint headers; mismatches inspect afresh.
  Failed sources and media deletion invalidate associated records.

The health-key version now includes the provider password and hashes media
associations. Older negative-cache keys are not reused. Quality settings, timeline
repair, audio/decode checks and deferred full-file archive CRC verification remain
unchanged.

Random sampling used xorshift seed `0x20261113`, unique cached TMDB discovery
titles from 1990–2023 excluding previous benchmark samples: two movies from ten
eligible titles and two shows from 154, with a random first-season episode 2–4.
Blade Runner remained an additional slow control. Both runs used fresh production
processes, empty private caches, identical copied settings/state, real archive
helpers and no Play prewarming; distinct samples within a run shared the pool.

| Sample | Before | After |
| --- | ---: | ---: |
| The Dark Knight | 12.0 s | 11.6 s |
| The Shawshank Redemption | 17.2 s | 17.0 s |
| WandaVision S01E02 | 15.0 s | 6.7 s |
| Raw S01E04 | No compatible SDR release | No compatible SDR release |
| Blade Runner 2049 | 50.2 s | 27.5 s |

Times measure Play click to decoded, advancing browser video. All four playable
after-runs sustained another three seconds. WandaVision selected a different
1080p upload; the other playable titles retained their release titles. Live
results and provider latency were not frozen, so these are observations, not
isolated estimates for each optimisation. Raw's failed random pick was retained,
not replaced with an easier episode. Only WandaVision met ten seconds.

A further process restart preserved disk records but cleared in-memory sources:
Blade Runner emitted `archive-layout-reused` for all 123 volumes and sustained
real video at 27.6 seconds. This proves layout persistence/reuse, not an additional
startup-time improvement in that observation.

Verification: 112 distinct focused regressions passed across the checks, including
provider pooling and existing plan/probe persistence; the production build passed.
The first check caught two duplicate-probe race failures, fixed by publishing
rejection inside the admitted operation; both now pass. Existing Svelte
`searchInput` reactivity and bundle-size warnings remain unrelated.

Settings and watch history were not changed. Isolated credentials, caches,
services, browser tab and temporary reports are removed after verification.

## Reuse archive validation bytes during startup (2026-11-13)

Profiling the selected Blade Runner archive found repeated payload downloads:
metadata/timeline validation read the opening, then FFmpeg requested those bytes
after the archive loader's 8 MiB local cache had evicted them. Archive range reads
now use the same source-keyed 64 MiB global segment cache as ordinary direct
playback. Validated bytes survive local loader eviction without raising either
cache budget. Separately opened inputs and volumes have distinct identities, so
matching article IDs cannot leak bytes across sources/providers.

The fix changes only byte reuse. FFprobe arguments, the twenty-second opening
packet scan, audio selection, archive/header validation, first-segment checks and
throughput requirements are unchanged. The configured timeline-repair option was
enabled throughout these measurements.

Fresh processes profiled the same selected stored archive before and after:

| Source-level measurement | Before | After |
| --- | ---: | ---: |
| Payload articles fetched by range loaders | 91 | 47 |
| Payload bytes fetched by range loaders | 66.2 MiB | 34.0 MiB |
| Archive opening through validated preflight | 25.5 s | 20.8 s |
| Encoding start to first segment | 6.0 s | 2.8 s |

These payload counters exclude the unchanged archive-header inspection downloads.
The source involved roughly 32 MiB of distinct requested ranges. Provider latency
also varies, so the timing difference is not an isolated estimate of the cache's
effect; the reduction in repeated downloads is covered by a deterministic test.

Actual production-browser playback used the configured Best quality preset, no
Play prewarming, a fresh server with initially empty caches and the complete
archive-helper environment. Subsequent distinct titles shared the provider pool.

| Sample | Previous observation | Current cold startup |
| --- | ---: | ---: |
| Blade Runner 2049 | No advancing video within 60 s | 39.4 s |
| Arrival | 12.7 s | 13.6 s |
| Severance S01E02 | 15.2 s | 14.6 s |

All three current runs decoded video and advanced for another three seconds;
Blade Runner was also visually captured playing. Selected release titles were
unchanged, but live search results/provider timing were not frozen. The current
Blade Runner trace spent 13.5 seconds opening the chosen archive and 13.3 seconds
in metadata/timeline probing, so a reliable ten-second cold-start target remains
unmet. The other samples do not establish a general speedup.

Verification: 38 focused archive/cache/seek/resume regressions and the production
build passed. New coverage proves byte-exact reuse after a metadata scan exceeds
the local cache and isolation between providers with matching article IDs.
Settings and watch history were unchanged; the isolated server, copied credentials,
cache and profiling harness were removed after verification.

## Rolling archive headers and sparse movie discovery (2026-11-13)

The slow-title investigation first corrected the benchmark environment: isolated
servers now have the real `scripts/progressive-archive.py` helper and libarchive.
The previous fixture omitted the helper, so compressed-archive opening and
deferred archive verification did not exercise their complete production paths.
Earlier numbers remain historical observations, not clean production comparisons.

A valid Blade Runner 2049 cold run still missed sixty seconds. Its selected
stored archive contains 123 volumes. Profiling showed the mapper waiting for the
slowest reader in each eight-header batch while other connections sat idle.
Inspection now refills eight workers independently. Each worker parses and releases
its header buffer immediately, retaining only member metadata. All active readers
settle before failure/fallback, and every volume still passes the existing CRC,
format, filename, split-flag, member-size and total-size validation before playback.
Neither provider concurrency limits nor extraction concurrency were increased.

| Stage | Before | After rolling inspection |
| --- | ---: | ---: |
| Standalone inspection of the same 123-volume archive | 28.2 s | 9.2 s |
| Archive opening in the actual Blade Runner browser run | 34.6 s | 12.6 s |
| Metadata probing in that browser run | 8.8 s | 28.8 s |

Individual provider response times also improved between standalone profiles;
the entire measured difference cannot be attributed to scheduling. A deterministic
regression gates an early volume until a later volume is requested, checks the
eight-reader bound and verifies byte-exact playback across a later volume boundary.

Additional samples exposed a separate discovery failure. Arrival's movie endpoint
returned one unavailable CAM upload; the same generic query returned 127 candidates.
Movie discovery now uses its existing generic-search fallback for one-result
responses as well as empty responses, matching the sparse episode-search policy.
Primary results survive a generic endpoint failure. The tradeoff is an additional
bounded search round for sparse movie results; multi-result primary searches keep
their existing path.

The following production-browser observations used the configured Best quality
preset without Play prewarming. The four additional titles were picked using seed
`20261113`; Blade Runner was retained as the slow anchor. Initial caches were empty
for each server round; subsequent distinct titles shared the running provider pool.
Arrival was checked again on a fresh server/cache after its discovery fix.

| Sample | Latest cold startup | Outcome |
| --- | ---: | --- |
| Blade Runner 2049 | No advancing video within 60 s | Still blocked on startup |
| Arrival | 12.7 s | Played 2160p; previously unavailable |
| The Grand Budapest Hotel | 11.7 s | Played 2160p |
| Severance S01E02 | 15.2 s | Played 1080p |
| Dark S01E02 | 7.8 s | Played 1080p |

All four successful new-title runs decoded video and advanced for another three
seconds. Arrival's recovered selection was
`Arrival.2016.2160p.ATVP.WEB-DL.DD.5.1.H.265-PiRaTeS`.
Blade Runner retained the same selected archive title; faster archive opening did
not produce an end-to-end playback improvement because later probing/segment
startup dominated. A reliable ten-second target remains unmet.

Verification: 36 archive/seek/resume regressions and 23 discovery regressions
passed, including both new red-to-green cases. The production build passed.
Settings and watch history were unchanged. The isolated server, copied credentials,
profiling harness and temporary cache were removed after measurement.

## Bounded availability, Play intent and metadata reuse (2026-11-12)

> Benchmark caveat: the historical browser fixture below lacked the Python archive
> helper. See the 2026-11-13 investigation above for complete-environment results.

Automatic foreground selection now checks supported archive article availability
inside the existing six-candidate lookahead. One reader checks at most four
representative article IDs with a 1.5-second deadline; extraction remains serial.
Single-connection providers skip this extra work. Only an explicit missing-article
response rejects an archive; provider errors and timeouts leave normal opening
responsible for deciding availability. BODY, audio, timeline and throughput
validation remain mandatory.

Provider/credential-scoped, memory-only hints retain positive/negative availability
for thirty seconds and NZB response latency for two minutes, bounded to 1,000
entries. Hints only reorder contiguous candidates with identical size tier,
audio confidence, resolution, release score and playback strategy. They never
remove a fallback or override the preset. A recent positive archive hint can
skip STAT, not the subsequent source opening or playback validation.

Explicit desktop Play hover or keyboard focus can prepare a new movie or a fully
selected episode after 350 ms. Ordinary catalogue poster hover does not trigger
this work. There is one new-title intent, a ten-second preparation budget and
only its first candidate is speculative; further candidates wait for Play.
Pointer/focus departure, policy changes and teardown cancel unclaimed work.
Manual selection, offline/downloaded media and data saver remain excluded.
Claimed preparation survives a late cancellation request, and mismatched playback
offsets cannot reuse it.

Metadata reuse is bounded to 64 immutable-content entries and 1 MiB of retained
JSON. Eligible sources include identified direct article layouts, complete
random-access stored archives and unchanged local files. Changed content, incomplete
archives, torrents, failures, cancellation and combined repair probes do not reuse
metadata. Cold FFprobe arguments and the existing opening timeline/audio validation
are unchanged: shortening the cold probe cannot safely guarantee late audio tracks.
A generated twelve-second MKV with French audio and English audio starting three
seconds late retained both tracks while making one actual metadata FFprobe call:

| Metadata fixture | First probe | Reuse |
| --- | ---: | ---: |
| Same immutable source, unchanged audio policy | 75.86 ms | 0.14 ms |

The production-browser sample used seed `20261113`, three movies and three
episodes, isolated copies of the configured Best quality settings and initial
release-health snapshot, fresh servers and empty initial playback caches for
each cold round. Timings start at Play and end at decoded, advancing video;
successful runs also advanced for another three seconds.

| Sample | Before, cold | After, cold | After, five-second Play-hover lead |
| --- | ---: | ---: | ---: |
| Interstellar | 16.1 s | 17.8 s | 9.7 s |
| Blade Runner 2049 | No advancing video within 60 s | 59.4 s | Not measured |
| Inception | 7.5 s | 8.6 s | 3.0 s |
| Fallout S01E02 | 7.0 s | 7.0 s | 6.4 s, no handoff |
| Ted Lasso S01E03 | 10.0 s | 8.5 s | Not measured |
| Foundation S01E03 | 14.1 s | 11.9 s | Not measured |

Selected release titles were unchanged between cold rounds. All six after-round
samples played, but cold results were mixed; this does not establish a general
speedup or a reliable ten-second target. Interstellar and Inception claimed their
hover preparation. Fallout's speculative candidate failed, so its foreground
result is not evidence of a prewarming improvement.

A subsequent catalogue smoke exposed abandoned successful prewarms retaining HLS
conversion slots. Session cancellation now closes retained HLS resources, and
foreground handoff cancels and waits for other retained unclaimed sessions to
close. Conversion-capacity exhaustion is a job-level error, not a bad-release
signal: healthy saved plans are retained and selection does not scan additional
sources or attempt torrent/download fallback for that error.

After that fix, four actual nine-second Inception Play hovers each completed
preparation and were cancelled on departure. Foreground playback then advanced
in 3.1 seconds using the warmed source cache; new prewarming was declined while
video was playing. The real catalogue Play control also accepted preparation
and cancelled it on departure, while poster-edge hover started none.

Verification: 234 focused regression scenarios passed across targeted runs,
including slot reuse after successful speculative cancellation and retention
of healthy new/saved sources under conversion-capacity exhaustion. The production
build passed. User settings and watch history were unchanged; live credentials,
cache data and diagnostics were confined to the temporary benchmark directory.

## Resume preparation, slow descriptions and duplicate articles (2026-11-12)

Resume preparation remains limited to saved Continue Watching items using online,
automatic playback without data saver. Ordinary catalogue posters do not prewarm.
Navigation no longer waits for the preparation acknowledgement. Concurrent client
requests share work; declined HTTP/application responses and failed server jobs
can be retried instead of retaining a failed preparation for thirty minutes.
A second server-side activity check prevents asynchronous state reads from
starting speculative work after foreground playback has already begun.

The baseline exposed a quality mismatch: Toy Story's speculative path skipped
its preferred 2160p archive and selected a 1080p direct release. Prewarming now
allows stored-RAR random access with the same audio, timeline and throughput
checks as foreground playback, then hands over the validated session. Archives
requiring extraction wait for foreground playback rather than starting an
unbounded speculative download or silently choosing a lower-quality release.

Foreground automatic selection can bypass a pending source description after
1.5 seconds, but only for an already-successful description with the same size
and audio-confidence tier, resolution, release score and inferred playback
strategy. The original candidate remains available if alternatives fail. The
grace deadline belongs to the original request, not each subsequent candidate.
Manual, speculative, offline and background preparation retain strict ordering;
lookahead, provider concurrency and playback validation limits remain unchanged.
The trace records `release-description-deferred`.

Recognized direct-video or archive article sets receive a canonical fingerprint,
independent of upload URL, filename, file order and repeated article IDs. Only a
confirmed `USENET_ARTICLE_MISSING` failure is remembered for that set. Concurrent
direct checks serialize identical sets so reposts do not repeat a known-missing
provider check; successful checks and temporary/invalid-body failures are not
reused. Fingerprints use the existing provider/media-scoped, 24-hour release-health
store and are cleared with that media's remembered failures. Raw article IDs are
not persisted. The trace records `duplicate-articles-skipped` when applicable.

The final production-browser runs used an isolated copy of the configured Best
quality settings, the same initial rejection snapshot, empty initial playback
caches and fresh servers for the cold and warm resume rounds. Both resume rounds
spent five seconds on title details before clicking Play; only the warm round
allowed preparation. The two additional cold samples started at position zero.
Timings below start at Play and end at decoded, advancing browser video.

| Sample | Cold | With five-second preparation lead | Resolution |
| --- | ---: | ---: | --- |
| Pulp Fiction, resume at 120 s | 11.0 s | 5.4 s | 2160p |
| Toy Story, resume at 120 s | 15.0 s | 6.1 s | 2160p |
| The Matrix | 17.0 s | Not measured | 1080p |
| The Last of Us S01E03 | 23.4 s | Not measured | 720p |

Both resume comparisons selected exactly the same release in cold and warm runs.
All six playback runs continued advancing, with watch history unchanged. A real
Continue Watching navigation completed in 290 ms while its preparation response
was deliberately held for five seconds. Existing prewarming already helped;
these changes fix quality preservation, retries and navigation rather than
establishing a general prewarming-speed improvement.

The Matrix exercised one slow-description bypass and The Last of Us exercised
three, but neither beat its preceding cold observation. No duplicate-article
skips occurred in these live samples. Live cold-start gains from deduplication
therefore remain unmeasured; deterministic direct/archive regressions establish
the skipped checks, including persistence across health-store restart. Provider
variation and unavailable candidates still prevent a reliable ten-second target.
The user's settings were not changed.

Verification: 173 focused regression scenarios passed across targeted runs,
including deterministic slow-request deadlines, fallback retention, tier
boundaries, cancellation, resume retries, archive quality preservation and
duplicate-article failure scope. The production build passed. A separate
playback-preparation smoke selected an equivalent ready source after 1.515 seconds
and cancelled the unused stalled request.

## Adaptive fallback and expanded samples (2026-11-12)

Repeated missing archives now defer further candidates at that resolution behind
other resolutions within the same size and audio-confidence tier. Deferral starts
after four missing-article archive failures. Already-prefetched work can finish;
the six-candidate lookahead does not refill with deferred work while a preferred
candidate is pending. Manual selection keeps its original order.

Unlike the previous four-failure cutoff, this is not a permanent exclusion:
deferred archives remain eligible if other candidates fail. NZB fetch concurrency,
provider checks, timeline/audio validation and live throughput checks are unchanged.
The startup trace records `archive-resolution-deferred` when the policy activates.

The broader run also found an identity bug: The Office (2005), S03E01 selected
an explicitly labelled 2001 UK-series Christmas special. An explicit year between
the title and episode tag must now match the requested series year. Years after
the episode tag remain eligible because they commonly identify the episode's air
year. Unlabelled releases remain eligible; this does not resolve every ambiguous
title. Saved-source scope advances to version 5 for both automatic and manual
scopes to invalidate earlier potentially incorrect saved choices.

Six additional samples were selected using seed `20261112`, taking three films
and three episodes from two six-item pools. This is a reproducible mixed sample,
not a random sample of the entire catalogue. Production-browser measurements
used the configured Best quality preset, isolated settings, the same rejection
snapshot, empty initial playback caches, fresh servers and the same sample order.

| Sample | Before | After |
| --- | ---: | ---: |
| Toy Story (1995) | 9.9 s | 9.8 s |
| The Dark Knight (2008) | 8.9 s | 10.2 s |
| The Matrix (1999) | 12.8 s | 14.1 s |
| Breaking Bad S02E03 | 7.0 s | 7.2 s |
| The Last of Us S01E03 | 28.1 s | 18.4 s |
| The Office (2005) S03E01 | Invalid: wrong series | 6.6 s |

The Last of Us retained the same 720p PEDRO release. Its report changed from
70 rejected candidates before selection to 19; the live trace shows resolution
deferral jumping ahead to the lower-resolution alternatives instead of consuming
the entire 1080p backlog. This targeted reduction did not improve every sample:
the unchanged Matrix selection still needed twelve ranked candidates and took
longer in this single comparison.

An additional See S02E06 check reached advancing video in 12.0 seconds. All seven
post-change samples reached decoded advancing video and continued playing, with
watch history unchanged; three started within ten seconds. The user's settings
were not changed. Live provider/indexer variation and unavailable releases still
prevent a reliable ten-second guarantee.

Verification: 108 focused search, prefetch, playback-selection, torrent and
persistence tests passed, as did the production build. The regression scenarios
prove early lower-resolution selection without fetching deferred NZBs, successful
return to a healthy archive after other resolutions fail, size-tier boundaries,
and TV-series year filtering without rejecting episode air years.

## Preset size deferral (2026-11-12)

Automatic selection now tries releases within a runtime-scaled soft cap first,
then releases with unknown size, then oversized fallbacks. Existing quality,
resolution and torrent-availability preferences still order candidates within
each tier; confirmed English audio retains priority over unverified anime audio.
The configured resolution ceiling and other eligibility filters remain unchanged.

| Preset | Soft cap per hour of runtime |
| --- | ---: |
| Fast | 2 GiB |
| Balanced | 4 GiB |
| Best quality | 6 GiB |

Runtime comes from the existing playback media's `durationHint` in seconds.
Missing or invalid runtime uses two hours for movies and 45 minutes for episodes;
missing, non-positive or non-finite sizes enter the unknown-size tier. A release
exactly at its cap stays in the first tier. Caps apply to the indexer's reported
release size, not a measured video bitrate, and never remove fallback candidates.
Manual selection bypasses size deferral.

NZB/provider lookahead cannot cross a size-tier boundary until playback checks
have exhausted the current tier. Torrent swarm sorting also stays within size
tiers. Automatic saved-source scope advances to version 4 so previous automatic
choices are reselected; manual scopes retain version 3.

An isolated production-browser comparison used the same settings and rejection
snapshot as the preceding measurements, with empty playback caches, a fresh
server per preset and the same sample order. Only the isolated copy's preset
changed; the user's configured Best quality preset was not changed.

| Sample | Preset | Before size deferral | With size deferral |
| --- | --- | ---: | ---: |
| Pulp Fiction | Best quality | 11.6 s | 9.0 s |
| See S02E06 | Best quality | 14.1 s | 21.5 s |
| Pulp Fiction | Fast | 16.6 s | 7.5 s |
| See S02E06 | Fast | 13.3 s | 7.2 s |

All four runs reached advancing decoded video and continued playing; watch
history remained unchanged. Fast selected a 0.94 GB 1080p Pulp Fiction release
and a 1.75 GB 720p See release. Best quality retained 2160p for Pulp Fiction
(15.01 GB) but tried three unavailable smaller See sources before selecting a
5.25 GB 1080p archive. Smaller-first can improve startup, especially in Fast,
but can regress when the preferred size tier contains unavailable sources.
These single live-provider observations do not establish a ten-second guarantee.

Verification: 107 focused release-search, prefetch, playback-selection, torrent
and persistence tests passed, along with the production build. Coverage includes
all preset caps, runtime scaling and fallback, exact cap boundaries, unknown
sizes, unchanged manual ordering, no cross-tier NZB/provider work, and successful
oversized fallback after earlier tiers fail.

## Further startup investigation (2026-11-12)

Archive opening now fetches its first and last article concurrently. Failure
aborts the peer request and waits for both inspections to settle before returning
the original error. Stored-RAR inspection uses an eight-header window instead
of four; provider socket limits still apply, all headers are checked in volume
order, and ordinary video/extraction range reads remain serialized.

Another isolated production-browser comparison retained the same configured
quality preference, release-health snapshot, empty initial playback cache and
sample order. A separate round changed only the isolated copy to the existing
Fast preset. The user's settings were not changed.

| Sample | Prior quality run | Current quality run | Fast preset |
| --- | ---: | ---: | ---: |
| Pulp Fiction | 12.1 s | 11.6 s | 16.6 s |
| See S02E06 | 13.3 s | 14.1 s | 13.3 s |

The quality runs selected the same 2160p releases. Fast selected different 1080p
archives. All four new runs reached advancing video and continued playing; watch
history remained unchanged. These observations do not establish a reliable total
startup improvement or a ten-second guarantee. In the See comparison, archive
opening fell from 4.6 to 4.1 seconds, but timeline inspection increased from
2.9 to 3.9 seconds. Lowering quality alone was not a reliable startup fix.

Other measured hypotheses were not adopted:

- Three parallel NZB requests took 2.21 seconds for the preferred Pulp Fiction
  description versus 2.04 seconds alone, without a persuasive contention benefit.
- Its twenty-second opening inspection read about 40–43 MB. Forward-only
  Matroska inspection removed tail-range requests, but independently cold
  observations took 2.39 seconds versus 1.90 seconds with ordinary seeking.
  The existing seek policy, timeline checks and output-speed sample remain.

Ten targeted archive regressions and five provider-pool checks passed, as did
the production build. The regressions exercise independent first/last opening,
independently arriving stored headers through the real NNTP archive reader,
correct bytes across volumes and rejection of damaged headers beyond the first
eight-header batch. A separate failure scenario confirmed that both opening
clients are released while preserving the original missing-article error.

## Release selection startup (2026-11-12)

Production-browser comparisons used isolated copies of the configured settings
and the same provider rejection-history snapshot. Each comparison round started
with an empty playback cache and a fresh server, testing the same titles in the
same order. Timings end at advancing browser video; the unavailable episode's
timing ends at its terminal selection error. These are live-provider observations,
not latency guarantees.

| Sample | Before | After | Result |
| --- | ---: | ---: | --- |
| Pulp Fiction | 12.0 s | 12.1 s | Same 2160p release played; no meaningful speed gain |
| See S02E06 | 17.7 s | 13.3 s | Same 2160p release played |
| C.I.D. S01E414 | 11.5 s | 8.2 s | No compatible release; failure reported sooner |

Stored-RAR opening now checks up to four volume headers concurrently through
independent, validated article reads. Ordinary archive ranges remain serialized:
their small loader cache must not evict a loader still serving another request.
Headers are validated in volume order, including later batches; header CRC,
filename, split flags and inferred volume-size checks remain required. All reads
in a batch settle before extraction fallback can reuse or close the input.
Short first articles still use the ordinary range reader to obtain a full header.

When repair mode or torrent preflight already requires timeline validation before
encoding, one bounded FFprobe pass now supplies both metadata and opening packets.
Other playback retains early metadata publication and speculative encoding.
This did not materially improve the Pulp Fiction observation; timeline checks and
the two-second output-speed sample remain enabled.

Empty episode searches no longer repeat the generic tagged-title and alias search
already exhausted by the first pass. Movies retain their yearless fallback.
The terminal error no longer implies that an unavailable episode had HDR releases.

The archive regression exercises the real NNTP archive reader, independently
arriving headers and exact playback bytes across a volume boundary. Late damaged
headers still reject random-access playback. Fifty-five focused inspection,
timeline, availability and search checks, ten archive checks, and the production
build passed. Both playable samples continued playing, and watch history remained
unchanged. Neither playable sample consistently meets the ten-second target yet.

## Silo archive readiness race (2026-10-10)

Silo S01E02 opened a stored RAR successfully, then FFprobe reported an HTTP EOF
almost immediately and playback fell back to a full download. The browser's
interruption history showed three “Conversion is not ready” retries immediately
before the download. An API-only local replay streamed the same release, which
initially hid the browser-dependent failure.

Archive opening assigned `status: ready` and notified status subscribers before
the caller resumed to run preflight. A long-poll response could therefore expose
an archive without a prepared HLS session. The browser's failed HLS requests
triggered automatic download fallback, whose server endpoint accepted the request
even though the job was now selecting. Fallback closed the archive reader while
FFprobe was reading it, producing EOF and disabling further progressive attempts.

A separate localhost server inside the deployed container reproduced the same
EOF by replaying that status/HLS/fallback sequence. With the readiness fix applied
to that isolated copy, the same release produced a segment, and the first ready
response contained its validated HLS session. No EOF or full download occurred.
The live server was not restarted or modified during these checks.

Archive opening now stays selecting until preflight succeeds; validated readiness
wakes subscribers even when diagnostics are disabled. The fallback endpoint rejects
requests while selection is running. Reader failures also preserve their underlying
cause, and missing required articles exclude an archive from full-download fallback.
A deterministic regression exercises the real progressive opening and status
notification boundary: it observes premature readiness before the fix and stays
selecting until validation completes afterwards. The full 434-test suite passed.

## Saved 4K resume preflight overlap (2026-09-24)

A deployed Continue Watching run for the 2160p SDR Azkaban release resumed a
saved direct source with NVENC. Source search was skipped. It took roughly
15–16 seconds from click to moving video: the live check spent about 11 seconds
between starting the converter and accepting the source, followed by browser
buffering. This is one live observation, not a repeatable latency guarantee.

The first-segment audio probe and the required two-second output-speed sample
previously ran in sequence. They now run together once the first segment is
ready. The session is still withheld until both checks pass, and the speed
threshold uses the actual observation time when the probe takes longer. This
can remove up to two seconds from a successful preflight; the 4K first-segment
generation and browser buffer remain. Diagnostic events now mark first-segment
readiness and completion of the opening audio/video probe so a deployed run
can distinguish those costs. The deployed image has not yet been updated with
this change, so the live latency improvement remains unmeasured.


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
Explicit offline downloads retain complete-file preparation. Automatic remaining-series preparation now caches stream choices without full-video downloads.

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

### Recovery loops during progressive playback (2026-09-14)

Live Silo diagnostics recorded a first-segment preparation timeout, followed by
`levelLoadError` (HTTP 500). One playlist failure occurred with 17.4 seconds still
buffered and no browser media error code. A later attempt exhausted the buffer
and the server fell back to downloading, while the page continued to show stale
ready/seeking state.

A controlled regression reproduced a conversion failure by withholding a local
archive tail for 18 seconds. FFmpeg's 15-second HTTP read timeout caused premature
stream-end and demuxer I/O errors, making HLS playlist reads fail. The same test
passes with the growing local input's read timeout disabled. The endpoint is
supposed to wait for extraction; its source failure, session cancellation and
idle cleanup remain active. Ordinary posted-file input keeps its network timeout.
This reproduces a mechanism matching the live failure; the old live response did
not retain its complete FFmpeg error text.

Progressive HLS readiness now extends its 45-second inactivity deadline when
extracted bytes advance, with a five-minute absolute limit. This avoids repeatedly
throwing away useful preparation during a cold resume. Other sources keep the
45-second limit. Tests cover resumed progress, no-progress expiry and the hard
limit.

The page checks job status even when detailed diagnostics are disabled. A server
fallback moves it into preparation/download progress and preserves the recovery
position, instead of leaving a stale ready player behind. Diagnostic entries now
show their error messages; fatal HLS reports retain HTTP status and session
identity. All 222 tests and an isolated production build passed before applying
these changes to the watched source tree.

The complete local archive replay then isolated a second, decisive failure:
`ctypes.cast(buffer, ptr)` in the native read callback retained old read buffers
through ctypes ownership cycles. With the default 1 GiB address-space limit,
the real downloaded Silo archive failed around its first gigabyte with
`I/O error when unstoring file`. A temporary 2 GiB limit moved the failure to
roughly two gigabytes. This was independent of provider availability and FFmpeg.

The callback now passes `ctypes.addressof(buffer)` while retaining the current
buffer explicitly until the next read. The original 1 GiB limit stays in place.
The entire 9,723,950,472-byte Silo video then extracted successfully through all
93 downloaded RAR volumes in 35.199 seconds. A 128 MiB fixture under a reduced
128 MiB child limit reproduces the old failure in about 1.4 seconds and passes
with the fix. Full-archive extraction verifies the archive path and native checks;
it is not a whole-episode browser playback test.

## Reuse progressive archive extraction across player sessions

Slow Horses S01E02 at approximately five minutes into the 4K HONE release
spent 13 seconds opening the archive and 51 seconds preparing its first resumed
segment, in addition to release selection. Previously, a new playback job had no
archive plan to reuse, and an unreferenced extractor expired after five seconds.

Validated progressive sources now enter a process-local resume cache. New
foreground playback jobs reuse the source and its extracted bytes when media,
provider, quality and audio settings match. Existing direct plans retain priority.
Rejected sources, explicit release choices and download/background jobs do not
use this shortcut. Retention leases prevent the extractor's short idle timeout
from deleting the cached prefix. Active consumers renew retention; idle entries
expire within five minutes of the last cache touch. The cache retains at most
two sources with a combined declared video size of 20 GiB. Extraction may
continue during this short retention window; eviction releases only the cache's
lease, leaving an active player intact. Server restarts clear this cache.

The regression first failed because the reopened job searched again and entered
an error state. It now reuses the same source. The real archive/HLS integration
also reopens through a separate playback job and resumes at 110.900803 seconds
within its eight-second segment budget while the archive tail remains blocked.
The production build passes. The full 226-test run had three timing failures
under overlapping build/playback load; all three passed when their files were
rerun serially after the build. A live before/after reopen measurement remains
unverified: automatic approval review blocked leaving the active player.

This improves repeat resumes within the retention window. Cold starts still
need archive extraction, and incomplete sources still require sequential input
processing up to the saved position. It does not promise instant 4K cold resumes.

After the user authorized the live reopen check, Slow Horses S01E02's 4K HONE
source recorded `archive-resume-hit` at 18:46:33 and `segments-ready` at
18:47:20 (47 seconds). The source search and archive opening were skipped, but
conversion of the prefix remained slow. Playback subsequently advanced with no
recorded interruptions and zero dropped frames in the observed sample. This
confirms source reuse, not a satisfactory fix for total resume latency. The
remaining conversion delay needs separate optimisation and validation.

## Accurate forward seeking within retained Matroska archives

Repeated output-side seeks decoded the discarded prefix even when its bytes
were cached. Retained, validated Matroska archive jobs now use accurate input
seeking with `-fflags +ignidx`. Cold preparations and other containers retain
the existing sequential path. Completed files retain ordinary indexed seeking.

Ignoring the index alone still allowed the real container to jump to tail
metadata. Returning HTTP errors for those speculative reads proved unreliable
on real 4K files and was removed. The final converter-only HTTP view replaces
complete SeekHead elements in the initial 64 KiB with equal-length EBML Void.
All byte offsets and media bytes remain unchanged. Normal readers receive the
original container. The converter discovers Info, Tracks and available clusters
in order and builds its seek index without requesting the unfinished tail.
All unavailable ranges and sequential reads continue to wait for extraction.

An isolated check using the real 9.7 GB cached Silo video, with only its first
3 GiB available over HTTP, reproduced the original hardware conversion failure.
The header view produced the first HLS segment in 2.310 seconds at a
410.617498-second offset. The regression suite compares resumed audio/video
hashes and timestamps with normal accurate seeking, verifies normal readers
are unchanged, and verifies truncated/non-Matroska headers are not rewritten.
This is a real-file isolated measurement, not a live browser timing claim.

Live testing also found archive opening could exceed the previous 30-second
limit. Production opening now has a bounded 120-second allowance, avoiding a
premature full-download fallback while the provider opens the archive. This
does not promise fast cold starts. Live warm-resume verification remains the
last check after restarting the development server.

## Larger archive reads for deep resumes (2026-09-20)

Progressive extraction now fetches 16 MiB per steady-state archive range,
up from 8 MiB. Long resumes still need their preceding archive bytes, but this
halves the number of sequential provider range requests needed to reach a given
offset. The small opening reads remain unchanged. The larger 32 MiB candidate
exceeded the helper's reduced-memory regression limit; 16 MiB passed it.

The targeted extraction, incomplete-archive HLS, forward-seek, and memory tests
pass. A live click-to-first-frame measurement against a film has not been made,
so the actual latency improvement depends on provider round-trip time and
throughput. The full suite passed 341 of 342 tests at this stage; the remaining background
download fixture independently fails because this host's VAAPI encoder cannot
process its MPEG-4 input.

## Direct ranges from stored RAR volumes (2026-09-20)

A saved time is not a reliable byte offset in a variable-bitrate film. For
stored RAR4 and RAR5 volumes, the server now validates the volume headers and
maps the contained video byte ranges to archive byte ranges. FFmpeg reads the
opening timeline and seeks using the video's container metadata; the source
fetches only the requested archive ranges. A late-film HLS fixture skips the
middle of the archived video and prepares a segment at 135 seconds. This removes
the need to extract the whole prefix before playback for this layout.

The mapping is used only when every volume has a matching, uncompressed video
part with valid header checksums and a consistent declared size. Other RAR and
7z layouts retain sequential progressive extraction. A separate full extraction
starts shortly after the first HLS segment is ready to preserve the archive's end-to-end
checksum check; failure then invalidates the direct-range source. Fetched Usenet
articles continue through the existing per-article validation. This has been
verified with local RAR4/RAR5 and HLS fixtures. A live provider film timing is
still needed to quantify the gain.
