# pyodide-sandbox — hardened, offline-first Pyodide execution sandbox.
#
# Serving is fully OFFLINE: the Pyodide package cache is warmed at BUILD time
# (the only network step), wheels are vendored + sha256-locked in the repo,
# and the server runs under Node's permission model (docs/threat-model.md §4.6):
#
#   node --permission --allow-worker --allow-fs-read=/app --allow-fs-write=/app/data
#
# The container user is non-root. Pair with read_only / cap_drop / mem_limit
# from docker-compose.yml for the outer hardening layer.
#
# NOTE on the admin online package install: it needs egress + write access to
# /app/wheels, both deliberately absent here (fail-closed by design). In
# containerized deployments, bake dependencies in at build time instead —
# warm your cache/manifest into the image or rebuild with a new --config.

FROM node:24-slim

WORKDIR /app

# Absolute paths: config resolves relative paths against the cwd, and a
# container must never depend on how the entrypoint was invoked.
ENV SBX_HOST=0.0.0.0 \
    SBX_PORT=8787 \
    SBX_CACHE_DIR=/app/pkg-cache \
    SBX_WHEELS_DIR=/app/wheels \
    SBX_DB_PATH=/app/data/sbx.db \
    NODE_ENV=production

# dependency layer (cached by the lockfile; workspaces are symlinked)
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
RUN npm ci --no-audit --no-fund

# source + build-time cache warm (~8MB of pyodide packages, downloaded once;
# afterwards the serving path never touches the network)
COPY . .
RUN mkdir -p /app/data \
 && node packages/server/src/warm.mjs \
 && chown -R node:node /app/data /app/pkg-cache

USER node
EXPOSE 8787

# node-based healthcheck: node:24-slim ships no curl/wget
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SBX_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node itself is PID 1 — sbx-server handles SIGINT/SIGTERM for a graceful stop
CMD ["node", "--permission", "--allow-worker", "--allow-fs-read=/app", "--allow-fs-write=/app/data", "packages/server/bin/sbx-server.mjs"]
