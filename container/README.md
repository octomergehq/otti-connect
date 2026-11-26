# The Otti Connect container image

For a computer that is always on, such as a home server: Otti Connect with
the agents it runs, Claude Code, Codex and Google Antigravity's CLI, at the
versions Octomerge tests with it, on Node.js 22. It connects the machine to
Octomerge as one of your agent hosts, as `otti-connect` does on a computer of
yours, and runs the same agents at the same versions. You approve its sign-in
once and sign in to each agent in its terminal, once; your chats then run
their agent in it, while their files and commands stay on their own workers.

| File | |
| --- | --- |
| `Dockerfile` | Otti Connect (a release from Octomerge's npm registry, or this folder's source), the agents it pins, installed by its own installer into `/opt/otti-connect/agents` with their programs on the `PATH`, tini, and the user `otti` |

## Build

In the package's folder (the one above this):

```sh
docker build -t otti-connect -f container/Dockerfile .
```

That builds Otti Connect from source. To put a release in the image, as
Octomerge's registry publishes it:

```sh
docker build -t otti-connect -f container/Dockerfile \
  --build-arg OTTI_CONNECT_VERSION=<version> .
```

The image is for the platform you build on (Docker Desktop on an Apple
silicon Mac builds linux/arm64, on an Intel Mac or a Linux PC linux/amd64).
`docker buildx build --platform linux/amd64,linux/arm64` builds both on one
machine, without an emulator: every step runs on the build's own platform,
and Otti Connect installs the agents' builds for each image's platform.

## Run

1. Start it the first time in the foreground, so you see the code to approve:

   ```sh
   docker run -it --name otti-connect --hostname home-server \
     --restart unless-stopped \
     -e OTTI_CONNECT_LABEL=home-server \
     -v otti-connect:/home/otti otti-connect
   ```

   It prints an address and a code: approve the code in your browser, where
   you're signed in to Octomerge, and it says it is connected as
   `home-server`. Leave it running with Ctrl+P Ctrl+Q, which detaches the
   terminal; `--restart unless-stopped` starts it again after a reboot.
   Started with `-d` instead of `-it`, it prints the same lines to its log:
   `docker logs -f otti-connect`.

   `OTTI_CONNECT_LABEL` names the machine in Settings → Your agents (the
   container's host name by default). `-e OTTI_CONNECT_BASE_URL=<url>`
   connects it to another Octomerge than https://octomerge.dev.

2. Sign in to each agent in the container's terminal, once, with its own
   sign-in:

   ```sh
   docker exec -it otti-connect claude auth login
   docker exec -it otti-connect codex login --device-auth
   docker exec -it otti-connect agy acp --login
   ```

   Each prints an address to open in the browser, and Claude Code and
   Antigravity a code to paste back. Otti Connect checks the agents every few
   minutes and tells Octomerge; `docker exec otti-connect otti-connect status`
   shows what it finds now.

The agents are in the image, under `/opt/otti-connect/agents`, and stay at
its versions: a newer image brings newer ones. The volume `otti-connect` is
the home of the image's user, `otti` (uid 1000): it keeps Otti Connect's
sign-in (`~/.otti-connect`) and the agents' (`~/.claude`, `~/.codex`,
`~/.gemini`). A new container for a newer image takes the same volume and
keeps them: `docker rm -f otti-connect`, then the same `docker run`.

`docker stop otti-connect` ends the turns that run and reports them to
Octomerge before it stops. `docker exec otti-connect otti-connect logout`
signs the machine out of Octomerge and revokes its sign-in.

Run the agents' sign-ins in a terminal of the machine itself (`docker exec`):
a terminal relayed through a service would pass the agents' sign-in codes
through it, which Anthropic's terms don't allow a product to do for Claude's.

`docker exec otti-connect otti-connect --version` names Otti Connect's
version and the protocol version it speaks.
