FROM oven/bun:1.3.14

WORKDIR /app

# Playwright's Chromium (embed providers), ffmpeg (MKV -> MP4 remux) and the
# Mesa VA-API driver (optional hardware encode when a /dev/dri node is passed in).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        ffmpeg \
        mesa-va-drivers \
        vainfo \
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
ARG NEXT_PUBLIC_PLAYBACK_RANDOM_ACCESS_REMUX=1
ENV NEXT_PUBLIC_PLAYBACK_RANDOM_ACCESS_REMUX=${NEXT_PUBLIC_PLAYBACK_RANDOM_ACCESS_REMUX}
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
ARG NODE_ARCHIVE_SHA256=783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8
ARG NODE_DOWNLOAD_IP=""
RUN set -eux; \
    archive="node-v${NODE_VERSION}-linux-x64.tar.gz"; \
    if [ -n "${NODE_DOWNLOAD_IP}" ]; then \
      curl -fsS --resolve "nodejs.org:443:${NODE_DOWNLOAD_IP}" \
        "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" -o "/tmp/${archive}"; \
    else \
      curl -fsS "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" -o "/tmp/${archive}"; \
    fi; \
    echo "${NODE_ARCHIVE_SHA256}  /tmp/${archive}" | sha256sum -c -; \
    tar -xzf "/tmp/${archive}" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f "/tmp/${archive}"; \
    node --version

ENV NODE_ENV=production

EXPOSE 3000 3030

RUN chmod +x start.sh
CMD ["./start.sh"]
