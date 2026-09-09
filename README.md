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

FFmpeg, ffprobe, unrar and 7-Zip are included. Software video conversion works
without host devices; VAAPI acceleration additionally requires compatible host
GPU devices and drivers.

To build locally (including the test suite):

```sh
docker build -t watchhouse:local .
```

Local settings, downloads, credentials and generated build output are excluded
from the Docker build context.
