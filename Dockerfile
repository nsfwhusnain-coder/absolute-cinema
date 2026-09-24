FROM oven/bun:1.3.14

WORKDIR /app

# ffmpeg rewraps MKV releases for the browser; Playwright's Chromium (installed
# below) resolves some web sources.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install main app dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Install scraper mini-service dependencies. Copy its lockfile before install:
# without it, the scraper can resolve a newer Playwright than the browser
# downloaded below, leaving the provider pool with no matching executable.
COPY mini-services/stream-scraper/package.json mini-services/stream-scraper/bun.lock ./mini-services/stream-scraper/
RUN cd mini-services/stream-scraper && bun install --frozen-lockfile

# Install headless Chromium + its OS-level deps for Playwright
RUN bunx playwright install --with-deps chromium

# Copy the rest of the source
COPY . .

# Generate Prisma client and build the Next.js standalone server
RUN bunx prisma generate
RUN rm -rf .next && bun run build

# Next's standalone tracing can miss the Prisma query engine binary — copy it in explicitly
RUN mkdir -p .next/standalone/node_modules/.prisma .next/standalone/node_modules/@prisma \
    && cp -r node_modules/.prisma/. .next/standalone/node_modules/.prisma/ \
    && cp -r node_modules/@prisma/client/. .next/standalone/node_modules/@prisma/client/

# The web app runs on Node (Next.js standalone); Bun runs the scraper and the
# build. Node's stream handling holds far less memory than Bun's when proxying
# large HLS fragments. The archive is checksum-verified. NODE_DOWNLOAD_IP is an
# optional escape hatch for build hosts that cannot resolve nodejs.org.
ARG NODE_VERSION=24.18.0
ARG NODE_DOWNLOAD_IP=""
# Official Node tarball for this machine's architecture (x64 or arm64),
# verified against the SHASUMS file signed by the Node release team.
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "unsupported architecture"; exit 1 ;; \
    esac; \
    base="https://nodejs.org/dist/v${NODE_VERSION}"; \
    resolve=""; \
    if [ -n "${NODE_DOWNLOAD_IP}" ]; then resolve="--resolve nodejs.org:443:${NODE_DOWNLOAD_IP}"; fi; \
    archive="node-v${NODE_VERSION}-linux-${arch}.tar.gz"; \
    curl -fsS $resolve "${base}/${archive}" -o "/tmp/${archive}"; \
    curl -fsS $resolve "${base}/SHASUMS256.txt" -o /tmp/SHASUMS256.txt; \
    (cd /tmp && grep " ${archive}\$" SHASUMS256.txt | sha256sum -c -); \
    tar -xzf "/tmp/${archive}" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f "/tmp/${archive}" /tmp/SHASUMS256.txt; \
    node --version

ENV NODE_ENV=production

EXPOSE 3000

RUN chmod +x docker-entrypoint.sh
CMD ["./docker-entrypoint.sh"]
