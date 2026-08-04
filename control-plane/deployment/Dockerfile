# P0 Step 5C.1 — Control Plane container (STAGING-READY BUT NOT DEPLOYED).
#
# Build context is the repository root (the Control Plane imports pure protocol modules from
# lib/protocol/*). This image is a design artifact — it is NOT built or deployed in this step,
# does not modify any VPS/Cloudflare/DNS, and contains NO secrets.
#
#   docker build -f control-plane/deployment/Dockerfile -t avc-control-plane:skeleton .
#   docker run --rm -p 8787:8787 --env-file control-plane/config/.env.example avc-control-plane:skeleton

# Base image: node:22-alpine, pinned by digest.
#
# `node:22-alpine` is a moving tag, so an unpinned base means two builds of the same commit can produce
# different images. This is the multi-arch index digest, so it still resolves on both amd64 and arm64.
#
# The tag is named in this comment block rather than after the instruction because a Dockerfile has no
# inline comments — a trailing "# node:22-alpine" would be parsed as a fourth argument to FROM and fail.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime

# Non-root user for least privilege.
RUN addgroup -S cp && adduser -S cp -G cp

# Dedicated working directory.
WORKDIR /app

# Runtime deps only (the repo's single dependency is `ws`, unused by the skeleton but kept
# for a faithful production image). Copy manifests first for layer caching.
COPY package.json ./
# No lockfile install step here: the skeleton uses only Node built-ins + pure lib/protocol.
# When persistence/gateway land (5C.2+), add: RUN npm ci --omit=dev

# Copy only what the Control Plane needs: its own source + the pure protocol modules.
COPY lib/protocol ./lib/protocol
COPY control-plane ./control-plane

USER cp

ENV CONTROL_PLANE_ENV=staging \
    CONTROL_PLANE_HOST=0.0.0.0 \
    CONTROL_PLANE_PORT=8787

# Expose only the configured Control Plane port.
EXPOSE 8787

# Container healthcheck hits the cheap liveness endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CONTROL_PLANE_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node handles SIGTERM; main.mjs installs a graceful-shutdown handler.
ENTRYPOINT ["node", "control-plane/src/main.mjs"]
