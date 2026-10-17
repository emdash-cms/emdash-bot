# Execution sandbox for the EmDash bot author. Debian with Node 24, pnpm, git
# and ripgrep, plus the Sandbox SDK helper. Internet access is disabled at
# runtime; the Worker intercepts and filters the allowed hosts.
# Chromium for browser tests comes from the official Playwright image at the
# version EmDash pins (update both together). Copying it avoids a TLS download
# during the build; the egress gate blocks browser downloads at runtime.
FROM mcr.microsoft.com/playwright:v1.61.1-noble AS browsers
RUN rm -rf /ms-playwright/firefox-* /ms-playwright/webkit-*

FROM node:24-trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep ca-certificates bash jq python3 build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.33.4 --activate \
    && git config --system advice.detachedHead false

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# EmDash's root build exceeds Node's default heap in the core package; 6 GB
# was still too little in practice. A ceiling, not a reservation: kept below
# the sandbox's 12 GiB so Node fails with its own error before the container
# runs out of memory.
ENV NODE_OPTIONS=--max-old-space-size=10240
COPY --from=browsers /ms-playwright /ms-playwright
RUN npx -y playwright@1.61.1 install-deps chromium && rm -rf /root/.npm /var/lib/apt/lists/*

COPY --from=docker.io/cloudflare/sandbox:1.0.1 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

RUN mkdir /workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]
