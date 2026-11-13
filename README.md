# Watchhouse

## Discovery and proactive streaming

Home includes movies released from January 1 through today in the current UTC
year. Discovery shelves load additional TMDB pages as you approach their right
edge, with retry controls on failures; Continue watching remains your saved list.

Browsing Home queues background release selection for its movies and the first
aired episode of its shows. Newly loaded shelf pages join the same queue. Selection
uses the active playback preference, target resolution and provider configuration;
changing settings cancels pending work and prevents reuse of incompatible choices.
Manual release selection disables automatic preparation.

Preparation saves source metadata and performs bounded Usenet availability
probes, not full-video downloads, archive extraction or speculative conversion.
Usenet and torrent release selections, plus validated media metadata, survive
restarts without age or record-count eviction. They remain until the user clears
that movie/episode's cache or a failed playback check invalidates the source.
Selections stay isolated by provider and playback settings; changing settings
does not delete older selections. Existing saved metadata is retained on upgrade.
Temporary video/article buffers still use their size and retention limits.
Playback still checks the selected source when opening it: a prepared choice is
not a guarantee that articles or peers will remain available. Saved torrent
metadata can contain private tracker URLs and is written with owner-only access.

Release identity is checked against the leading movie/series title, including
catalogue aliases, before quality ranking. Episode names and uploader-group names
cannot satisfy a title match; sequels and labelled bonus features are excluded
when requesting the main film. Bracketed uploader prefixes, punctuation, numeric
titles and standard edition labels remain supported.
Selections cached before these identity checks are reselected once on upgrade.
Their records and completed offline downloads are not deleted.

**Prepare stream selections for the rest of the series** is enabled by default and queues stream choices
for every remaining aired episode, including later seasons. Unknown/future air
dates are skipped. The queue advances serially and Usenet probes yield to active
playback when its buffer needs priority. This replaces automatic next-episode
offline downloads; explicit Downloads remain available separately.

### Local torrent fallback

The Docker image bundles [Jackett](https://github.com/Jackett/Jackett) and automatically connects Watchhouse to its
local Torznab endpoint. Public sources include **LimeTorrents** and
**The Pirate Bay**; no separate indexer service or API-key setup is needed.
Usenet remains preferred, with torrent fallback when no suitable Usenet stream
is found. Torrent-only configuration also works with automatic selection.

The bundled indexer listens only on `127.0.0.1:9117`; its admin interface is not
published. Its configuration and API key persist under `/app/data`. Set
`WATCHHOUSE_PUBLIC_INDEXERS` to a comma-separated list of Jackett indexer IDs to
choose public sources, or `WATCHHOUSE_BUNDLED_INDEXER=false` to disable it.
An explicit **Torznab indexer URL** and API key in Settings override the bundled
indexer. Source/dev runs without the bundled runtime still need an external
Torznab endpoint.

Public indexers can be unavailable, blocked, or require CAPTCHA; site connections
can also fail with TLS handshake errors or connection resets. Startup logs report
these failures without stopping Watchhouse. There is no bundled CAPTCHA bypass;
challenge-dependent sources such as TorrentDownloads are not enabled by default.
Preconfiguration does not guarantee search results or playable peers. Use the
VPN deployment below to protect server-side traffic; a standalone `docker run`
does **not** automatically provide a VPN.

Only torrent metadata is fetched proactively; magnet metadata lookup may contact
peers but does not fetch video pieces. HTTP download links that redirect to magnets
use the same metadata-only peer lookup rather than treating magnets as HTTP URLs.

Foreground torrent playback must pass a live FFmpeg/HLS speed check, including
cached and background-prepared selections. The ten-second check discards the
first five seconds of startup output, then requires sustained output at least
**1.25× viewing speed**. Borderline sources get four more seconds. Each preflight
is bounded to 40 seconds, with separate 20-second metadata and opening-timeline
probe limits. Failed sources are closed before another release is tried.
Each candidate gets at most twenty seconds to acquire torrent metadata; selection
continues through unique swarms within its overall 90-second deadline rather
than stopping after three checks. Cached validation and fallback search share
that deadline; a failed cached source does not restart the clock.
Successful checks retain their playable segments as the initial buffer.
This rejects observed stalls, but cannot
guarantee that peer speeds will remain sufficient throughout playback.

Advertised seeders rank torrents within compatible quality tiers before file
size, so tiny unavailable swarms do not consume the deadline ahead of healthier
releases. **Start fastest** with **Auto resolution** prefers smaller files when
seed counts tie. Explicit resolution and quality preferences retain their
priority; advertised availability never substitutes for the live playback check.
Repeated episode tags in a folder and filename are accepted when they all
identify the requested episode; conflicting episodes and multi-episode files
remain rejected.

Actual playback reads pieces into memory and feeds the existing FFmpeg
remux/transcode pipeline. Archives, wrong episodes and ambiguous video
collections are rejected. At most two 48 MiB windows retain stored pieces.
A separate 16 MiB header/index cache and 16 MiB recent-playhead cache retain
consumed, hash-verified pieces across player sessions, keyed by torrent info hash.
The total stored-piece budget remains 128 MiB, plus metadata/protocol buffers.
At most two HTTP readers run; additional seek/probe requests wait in a bounded
queue. No torrent video files are saved to disk.
Optional BEP6 allowed-fast grants are ignored because WebTorrent can request
those pieces outside the active window, exhausting its cache. Ordinary unchoked
downloads and other fast-extension messages remain supported.
Opening probes and playback reuse verified pieces and connections within a
retained window instead of downloading the same opening data repeatedly.
Matroska opening probes and playback from the beginning avoid unnecessary tail
index seeks; seeking to another playback position remains supported.
Completed and partially downloaded windows advance or seek by cancelling pending
block requests and clearing their cached, verified and partial piece state while
retaining established peer connections. Header → tail-index → saved-position
reads therefore do not need cold connections merely because a window
was not filled. Windows with a piece still being hashed/stored, or a failed
connection, use the fresh-connection path; remembered peers avoid rediscovery.
Evicted ranges must be downloaded again. Closing a source destroys its windows
and connections, but retains bounded resume bytes until evicted, the episode's
cache is cleared, or the process restarts. Opening a saved torrent still requires
a live peer, and resumed playback still passes the full sustained-speed check.
Repeated playback jobs sharing the same immutable torrent descriptor also reuse
its successfully validated track/timeline inspection; failed or cancelled
inspections are not reused. Clearing the episode cache removes that inspection.
Foreground selection hands its live magnet metadata connection to the first
playback window instead of reconnecting. Its initially zero-byte piece store is
enabled only after a window slot is reserved; unused metadata connections are
closed. Peer addresses are retained only in memory and are not persisted.
Saved selections establish a peer connection before starting the media probe.
This warmup counts toward the 40-second preflight limit and shares the same
bounded reader queue and piece windows; it does not download video proactively.
Up to 64 DHT contacts are also retained in memory and supplied to fresh clients
without replacing their normal bootstrap servers or adding another DHT client.
Connection errors and closure interrupt pending reads instead of leaving them
waiting for the range timeout.
If torrent playback stalls, automatic recovery excludes that swarm and validates
another release at the interrupted playhead, reusing its prepared HLS session.
Replacement selection has the same speed gate and 90-second deadline. Exhausted
alternatives stop with an error; the downloaded-copy fallback remains NZB-only.

Torrent activity exposes the server's peer IP address and depends on peer
availability; it is not debrid-backed streaming. Use sources you are entitled to
access and configure your network policy accordingly. Native `node-datachannel`
support is required by WebTorrent; its install script is explicitly allowed in
`package.json`. A scoped `uint8-util` override keeps WebTorrent's string-hash
handling compatible with its byte utility.

## Docker Hub publishing

Every push to `main` builds and tests the application, then publishes a Linux
AMD64 image to Docker Hub with these tags:

- `<username>/watchhouse:latest`
- `<username>/watchhouse:sha-<full-commit-sha>`

Before the first push, create a `watchhouse` repository in your Docker Hub account
and add these **repository secrets** in GitHub under **Settings → Secrets and
variables → Actions**:

| Secret | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | Your Docker Hub username |
| `DOCKERHUB_TOKEN` | A Docker Hub personal access token with Read and Write permissions |

Create the token in [Docker Hub account settings](https://app.docker.com/settings/personal-access-tokens).
The workflow uses Docker's [official GitHub Actions](https://docs.docker.com/guides/gha/)
and caches build layers between runs. A failed test or build prevents publication.

## Run the image

Replace `<username>` with your Docker Hub username:

```sh
docker run -d --name watchhouse \
  -p 3000:3000 \
  -e ORIGIN=http://localhost:3000 \
  -v watchhouse-data:/app/data \
  <username>/watchhouse:latest
```

Open `http://localhost:3000` and configure your providers in Settings. Set `ORIGIN`
to the actual URL you use if accessing the app through another hostname or a
reverse proxy. The named volume retains settings, cache and offline downloads
across container replacements. The image runs as the `node` user (UID 1000); bind
mounts used instead of the named volume must be writable by that user.

FFmpeg 9.0.2, ffprobe, unrar, 7-Zip, Python 3 and libarchive are included. The
Docker build compiles FFmpeg from a pinned, checksum-verified source release so
the image has the H.264, NVENC, VAAPI and HDR tone-mapping features used by
Watchhouse. Software video conversion works
without host devices. To enable VAAPI acceleration on Linux, including Intel
11th-generation Core graphics, expose the host DRM devices as well:

```sh
docker run -d --name watchhouse \
  --device /dev/dri:/dev/dri \
  -p 3000:3000 \
  -e ORIGIN=http://localhost:3000 \
  -v watchhouse-data:/app/data \
  <username>/watchhouse:latest
```

The image includes the Intel iHD and Mesa VAAPI drivers. At startup it grants
the unprivileged `node` process access to the mounted DRM-device groups, whose
numeric IDs vary between Linux distributions. Watchhouse prefers `renderD*`
nodes and falls back to `card*` nodes on appliance distributions that expose
only the primary DRM device. Playback diagnostics should then report
`GPU · VAAPI decode + encode` for SDR transcodes. If `/dev/dri` is not mounted,
Watchhouse safely falls back to software conversion.

For an NVIDIA GPU, install the NVIDIA driver and NVIDIA Container Toolkit on
the Docker host, then expose the GPU through the NVIDIA runtime:

```sh
docker run -d --name watchhouse \
  --gpus all \
  -e NVIDIA_DRIVER_CAPABILITIES=video,compute,utility \
  -p 3000:3000 \
  -e ORIGIN=http://localhost:3000 \
  -v watchhouse-data:/app/data \
  <username>/watchhouse:latest
```

Watchhouse probes `h264_nvenc` at startup and uses it when the NVIDIA runtime
has supplied a working GPU and encode libraries. Video decoding and HDR tone
mapping remain on the CPU for broad GPU-generation compatibility; H.264
encoding runs on NVENC. Playback diagnostics then report `GPU · NVENC encode`.
If Watchhouse runs inside a VM, the physical GPU must first be passed through
to that VM and the NVIDIA driver and Container Toolkit installed in the guest.

To build locally (including the test suite):

```sh
docker build -t watchhouse:local .
```

Local settings, downloads, credentials and generated build output are excluded
from the Docker build context.

### VPN deployment with Docker Compose

`compose.yaml` runs Watchhouse (including Jackett) in
[Gluetun's shared network namespace](https://github.com/qdm12/gluetun-wiki/blob/main/setup/connect-a-container-to-gluetun.md).
All outbound traffic goes through the VPN: torrent peers, indexer searches,
Usenet, and metadata requests. Gluetun's firewall stays enabled as the kill
switch, and Watchhouse starts only after Gluetun is healthy.

1. Install Docker Engine and Docker Compose v2.20 or later on a Linux host with
   `/dev/net/tun`.
2. Download a **WireGuard configuration** from your VPN provider. Use a provider
   and plan that permit peer-to-peer traffic. Put the file at `vpn/wg0.conf`
   beneath this checkout; create `vpn/` with mode `700` and protect the file
   with mode `600`. The file contains your private VPN key: do not commit or
   share it. `vpn/` is excluded from Git and Docker builds.
3. The peer's `Endpoint` must contain an IP address, not a hostname, as required
   by Gluetun's
   [custom WireGuard provider](https://github.com/qdm12/gluetun-wiki/blob/main/setup/providers/custom.md).
   Use a full-tunnel configuration. Provider-specific extensions or login-only
   VPN apps are not substitutes for a WireGuard configuration.
4. Start the deployment:

   ```sh
   docker compose up -d --build
   ```

Open `http://localhost:3000`. The default bind is loopback-only. For LAN access,
put these non-secret values in a local `.env`, using your host's real address:

```dotenv
WATCHHOUSE_BIND_ADDRESS=0.0.0.0
WATCHHOUSE_ORIGIN=http://your-server:3000
```

Only Watchhouse port 3000 is published, on Gluetun—not on Watchhouse. Jackett,
Gluetun's control API, and torrent listening ports are not published. No VPN
provider-side port forwarding is configured; peer availability can be lower
without it. Do not expose Watchhouse to the Internet without separate access
controls.

`WATCHHOUSE_PORT` changes the published port; update `WATCHHOUSE_ORIGIN` to
match. `WATCHHOUSE_WIREGUARD_CONFIG` selects a different host config-file path.
A missing config file prevents startup rather than falling back to direct
networking. `WATCHHOUSE_PUBLIC_INDEXERS` selects bundled public indexers.
Gluetun is pinned to a release and image digest.

Compose uses its own named volumes for Watchhouse data and Gluetun state.
An existing standalone container's data volume is not automatically migrated;
stop that container and configure the Compose volume to reuse it before
switching. `docker compose down` retains volumes; `down -v` deletes them.
Recreating Gluetun also requires recreating Watchhouse's shared network
namespace; use `docker compose up -d --force-recreate` for a VPN-container
replacement.

Inspect startup and source errors with `docker compose logs gluetun watchhouse`.
Never paste your WireGuard file or the bundled indexer's API key into reports.

DNS timeouts with no received tunnel packets can mean the WireGuard relay is
inactive, not that DNS settings are wrong. Check the provider's current relay
list ([Mullvad](https://api.mullvad.net/www/relays/all/)). When replacing a relay,
update its `Endpoint` and peer `PublicKey` together; preserve the private key.
For an existing file bind mount, edit the file in place or recreate the
containers so Gluetun reads the new inode. Restart Gluetun and Watchhouse, then
verify Gluetun's healthcheck and the provider's VPN exit check from inside
Watchhouse before testing discovery. Do not disable the firewall or health
dependency to work around an unhealthy tunnel.



## Playback logs

Server playback events are written to stdout as JSON lines, independently of
the Playback diagnostics setting. Each line includes a timestamp, `jobId`,
activity, and the available playback mode and strategy. HLS requests, readiness,
cancellations and preparation failures also include `sessionId`, the requested
`start` position in seconds, and elapsed preparation time where applicable.
Credential-shaped fields and HTTP URLs are redacted. Release titles can appear
in logs.

Capture an intermittent seek failure on the Docker host with:

```sh
docker logs --since 15m --timestamps watchhouse > playback.log 2>&1
```

Look for `hls-request`, `segments-ready`, `hls-error`, and `hls-cancelled`,
then correlate entries by `jobId` and `sessionId`. Container logs follow Docker's
configured retention policy. Browser-only seeks, buffering and player state
still require the watch page's **Download diagnostic report**; enable Playback
diagnostics before starting playback and download the report before refreshing.

Every release-click playback attempt is reported automatically, even when
**Playback diagnostics** is disabled and before a playback job exists. Startup
reports measure from the click until video advances: they record `started`, `slow`
at the 10-second target, and a terminal `playing`, `failed`, or `cancelled` outcome.
Ten seconds is a measured target, not a guaranteed startup time. The same attempt
is updated when a job attaches, including server-owned identity, recent events,
and release-selection evidence; late uploads cannot undo a terminal outcome.

With **Playback diagnostics** enabled, browser buffering lasting at least three
seconds is saved automatically to `data/playback-diagnostics.json`. Reports include
player samples before the stall, the stalled state, source/job identity, and recent
server events. Recovery, pause, and retry update the same incident. Startup and
buffering reports share the most recent 20 incidents (at most 128 KiB each),
outside the playback cache, so refreshing or clearing an episode cache does not
remove them. Failed reporting is best effort and does not affect playback. URLs
and credential-shaped fields are redacted on both sides. The file is written
with owner-only permissions.

Use **Download saved playback reports** in the watch page's diagnostics panel to
retrieve the saved history, or GET `/api/playback-diagnostics`. Container logs also
include `browser-buffering` and `browser-startup` entries for reports with a known
job, with the incident, position, buffer headroom, and duration. This feature needs
the updated server and browser build deployed; existing images do not record these
reports.

## Progressive archive playback

Foreground playback tries supported archives progressively after exhausting
usable direct-video releases, before committing to a full archive download.
It reads archive byte ranges on demand and extracts the largest video into a
growing temporary file. Playback can start once its opening audio/video checks
pass, while extraction continues. Regular split 7z and RAR sets and single ZIP
archives are eligible; unsupported compression/layouts fall back to the
full-download path. Known encrypted archives and archives with missing required
articles are skipped: full downloading cannot unlock or repair them. Progressive candidates are tried in release
ranking order; a lower-ranked progressive candidate can be selected before a
higher-ranked archive that requires full download, as with direct video selection.

Seeking into video that has not been extracted can take longer. Whole-file CRC
failures can only be reported when the relevant data has been processed; they
stop the progressive source rather than reporting successful completion.
Explicit offline downloads still use the complete download/extraction path.
Automatic series preparation selects stream sources only. An unclaimed source
expires after 30 seconds; after its last active player
releases it, extraction stops and its temporary video is removed after 5 seconds.

For local development, install `python3` and the system `libarchive` shared
library alongside the existing media tools. The helper is
`scripts/progressive-archive.py` and must be deployed with the Node build. Its
native decompression memory is capped at 1 GiB where resource limits are available.
Missing helper dependencies fall back to ordinary archive preparation.
