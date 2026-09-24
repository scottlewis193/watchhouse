# Watchhouse

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
Offline and next-episode downloads still use the complete download/extraction
path. An unclaimed source expires after 30 seconds; after its last active player
releases it, extraction stops and its temporary video is removed after 5 seconds.

For local development, install `python3` and the system `libarchive` shared
library alongside the existing media tools. The helper is
`scripts/progressive-archive.py` and must be deployed with the Node build. Its
native decompression memory is capped at 1 GiB where resource limits are available.
Missing helper dependencies fall back to ordinary archive preparation.
