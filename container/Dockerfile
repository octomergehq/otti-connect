# syntax=docker/dockerfile:1
# The Otti Connect container image (container/README.md): Otti Connect and the
# agents it runs, at the versions that Otti Connect pins (src/versions.ts), on
# Node.js 22, for a machine that is always on. It runs `otti-connect start`,
# which connects the machine to Octomerge as an agent host: its first start
# shows a code to approve in the browser. The person signs in to each agent in
# the container's own terminal, once, with the agent's own sign-in. The user's
# home, /home/otti, is a volume: it keeps Otti Connect's sign-in
# (~/.otti-connect) and the agents' (~/.claude, ~/.codex, ~/.gemini). Built in
# this folder (the package's), for this machine's platform or for several:
#
#   docker build -t otti-connect -f container/Dockerfile .
#   docker buildx build --platform linux/amd64,linux/arm64 -f container/Dockerfile \
#     --build-arg OTTI_CONNECT_VERSION=<version> [--build-arg NPM_REGISTRY=<registry>] .
#
# With OTTI_CONNECT_VERSION, the image holds that release of Otti Connect as
# NPM_REGISTRY publishes it; without it, Otti Connect built from this folder's
# source. Either way, Otti Connect's own installer puts in the agents that it
# pins, so the image runs the same agents as `npx @octomerge/otti-connect`.
#
# Both platforms build on any host, without an emulator: every RUN runs on the
# build's own platform. The agents install there for the image's platform
# (`otti-connect install --platform linux/<arch>`: npm picks the agents' builds
# for it, and Antigravity's archive is that platform's), tini and the CA
# certificates come as files, and the image's own stage only copies.

ARG NODE_IMAGE=node:22.23.5-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb
ARG BUN_IMAGE=oven/bun:1.4.5-alpine

FROM ${NODE_IMAGE} AS base

# tini 0.19.0, statically linked, for each architecture: PID 1, which hands
# Docker's stop to Otti Connect and reaps what the agents leave behind.
FROM scratch AS tini-amd64
ADD --checksum=sha256:c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee --chmod=0755 \
    https://github.com/krallin/tini/releases/download/v0.19.0/tini-static-amd64 /tini
FROM scratch AS tini-arm64
ADD --checksum=sha256:eae1d3aa50c48fb23b8cbdf4e369d0910dfc538566bfd09df89a774aa84a48b9 --chmod=0755 \
    https://github.com/krallin/tini/releases/download/v0.19.0/tini-static-arm64 /tini
FROM tini-${TARGETARCH} AS tini

# Otti Connect from this folder's source: one Node.js file.
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS source
WORKDIR /connector
COPY package.json ./
COPY src ./src
RUN bun build src/main.ts --target=node --format=esm --outfile=/out/otti-connect.mjs

# Otti Connect as the image holds it: the release OTTI_CONNECT_VERSION as
# NPM_REGISTRY publishes it, else the build from source.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS connector
ARG OTTI_CONNECT_VERSION=
ARG NPM_REGISTRY=https://npm.octomerge.dev
COPY --from=source /out/otti-connect.mjs /tmp/source/otti-connect.mjs
RUN <<'EOF'
set -eu
mkdir -p /opt/otti-connect/bin
if [ -n "$OTTI_CONNECT_VERSION" ]; then
  npm install --prefix /tmp/release --registry "$NPM_REGISTRY" --no-save --no-package-lock --no-audit --no-fund \
    --no-update-notifier --ignore-scripts "@octomerge/otti-connect@$OTTI_CONNECT_VERSION"
  package=/tmp/release/node_modules/@octomerge/otti-connect
  program=$(node -e 'const bin = require(process.argv[1]).bin; process.stdout.write(typeof bin === "string" ? bin : bin["otti-connect"])' "$package/package.json")
  cp "$package/$program" /opt/otti-connect/otti-connect.mjs
  rm -rf /tmp/release
else
  cp /tmp/source/otti-connect.mjs /opt/otti-connect/otti-connect.mjs
fi
chmod 0755 /opt/otti-connect/otti-connect.mjs
ln -s ../otti-connect.mjs /opt/otti-connect/bin/otti-connect
version=$(node /opt/otti-connect/otti-connect.mjs --version)
echo "$version"
if [ -n "$OTTI_CONNECT_VERSION" ] && [ "$(echo "$version" | cut -d' ' -f2)" != "$OTTI_CONNECT_VERSION" ]; then
  echo "The release says it is $version, not $OTTI_CONNECT_VERSION" >&2
  exit 1
fi
EOF

# The agents that this Otti Connect pins, installed by it for the image's
# platform, outside the home volume so that a newer image brings its own;
# and links to their own programs (claude, codex, agy), with which the person
# signs in to them. A failed install fails the build.
FROM connector AS agents
ARG TARGETARCH
RUN node /opt/otti-connect/otti-connect.mjs install --agents-dir /opt/otti-connect/agents \
      --platform "linux/${TARGETARCH}" --bin-dir /opt/otti-connect/bin \
 && chmod -R u=rwX,go=rX /opt/otti-connect

# The image's account, the node image's `node` (uid and gid 1000) renamed
# `otti`, with its home at /home/otti, which the volume mounts over; and the
# CA certificates the agents' own TLS reads, which the node image leaves out.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS system
COPY --from=base /etc/passwd /etc/group /etc/shadow /etc/gshadow /account/
COPY --from=base /etc/skel/ /out/home/otti/
RUN <<'EOF'
set -eu
apt-get update
apt-get install -y --no-install-recommends ca-certificates
rm -rf /var/lib/apt/lists/*
mkdir -p /out/etc/ssl/certs /out/shadow
cp /etc/ssl/certs/ca-certificates.crt /out/etc/ssl/certs/ca-certificates.crt
sed 's#^node:x:1000:1000:[^:]*:/home/node:/bin/bash$#otti:x:1000:1000:Otti Connect:/home/otti:/bin/bash#' /account/passwd > /out/etc/passwd
grep -qx 'otti:x:1000:1000:Otti Connect:/home/otti:/bin/bash' /out/etc/passwd
sed 's#^node:x:1000:$#otti:x:1000:#' /account/group > /out/etc/group
grep -qx 'otti:x:1000:' /out/etc/group
for file in shadow gshadow; do
  sed 's#^node:#otti:#' "/account/$file" > "/out/shadow/$file"
  grep -q '^otti:' "/out/shadow/$file"
done
if grep -q '^node:' /out/etc/passwd /out/etc/group /out/shadow/shadow /out/shadow/gshadow; then
  echo "The account node is still named somewhere" >&2
  exit 1
fi
chmod 0644 /out/etc/passwd /out/etc/group /out/etc/ssl/certs/ca-certificates.crt
chmod 0640 /out/shadow/shadow /out/shadow/gshadow
chmod 0700 /out/home/otti
EOF

FROM base
ARG OTTI_CONNECT_VERSION=
LABEL org.opencontainers.image.title="otti-connect" \
      org.opencontainers.image.description="Otti Connect with the agents it runs, Claude Code, Codex and Antigravity's CLI, at the versions Octomerge tests: connects the machine to Octomerge as an agent host. Mount a volume at /home/otti, approve its sign-in, and sign in to each agent in its terminal." \
      org.opencontainers.image.version="${OTTI_CONNECT_VERSION}" \
      org.opencontainers.image.url="https://octomerge.dev" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=system /out/etc/passwd /out/etc/group /etc/
# Debian's shadow group (gid 42) reads these.
COPY --from=system --chown=0:42 /out/shadow/shadow /out/shadow/gshadow /etc/
COPY --from=system /out/etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=tini /tini /usr/bin/tini
COPY --from=agents /opt/otti-connect /opt/otti-connect
COPY --from=system --chown=1000:1000 /out/home/ /home/
# The agents are root's, so they stay at the versions Otti Connect pins, and
# they don't try to update themselves.
ENV PATH=/opt/otti-connect/bin:$PATH \
    HOME=/home/otti \
    OTTI_CONNECT_AGENTS_DIR=/opt/otti-connect/agents \
    DISABLE_AUTOUPDATER=1 \
    AGY_CLI_DISABLE_AUTO_UPDATE=1 \
    NO_UPDATE_NOTIFIER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
USER 1000:1000
WORKDIR /home/otti
VOLUME ["/home/otti"]
ENTRYPOINT ["/usr/bin/tini", "--"]
# OTTI_CONNECT_BASE_URL and OTTI_CONNECT_LABEL, when set, name the Octomerge and the label.
CMD ["otti-connect", "start"]
