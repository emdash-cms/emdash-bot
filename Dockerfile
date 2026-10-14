# Execution sandbox for the EmDash bot author. Debian with Node 24, pnpm, git
# and ripgrep, plus the Sandbox SDK helper. Internet access is disabled at
# runtime; the Worker intercepts and filters the allowed hosts.
FROM node:24-trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep ca-certificates bash jq python3 build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.33.4 --activate \
    && git config --system advice.detachedHead false

# Browser tests (EmDash admin uses Vitest browser mode with Playwright). The
# egress gate blocks browser downloads at runtime, so Chromium is baked in at
# the Playwright version EmDash pins. Update it with EmDash's Playwright.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx -y playwright@1.61.1 install --with-deps chromium && rm -rf /root/.npm

COPY --from=docker.io/cloudflare/sandbox:1.0.1 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

RUN mkdir /workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]
