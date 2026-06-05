# RunFeature container — Node + Python base.  Python is included because the
# Claude Agent SDK frequently shells out to Python tooling (e.g. for docx/xlsx
# skills), so we want the runtime ready inside the same image.
FROM node:20-bookworm-slim

ENV PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    PORT=8088 \
    HOST=0.0.0.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-venv \
        ca-certificates \
        curl \
        bash \
        git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json tsconfig.json ./
COPY server.ts ./

# Install deps. We allow the install to fall through if the optional
# `@anthropic-ai/claude-agent-sdk` package can't be resolved at build time —
# `server.ts` only requires `@anthropic-ai/sdk` at runtime.
RUN npm install --omit=optional --no-audit --no-fund || \
    (echo "claude-agent-sdk install failed; retrying with sdk only" && \
     npm install @anthropic-ai/sdk@^0.30.0 typescript@^5.4.0 tsx@^4.7.0 @types/node@^20.11.0 --no-audit --no-fund)

# Pre-compile TypeScript so the container start is fast.
RUN npx tsc

EXPOSE 8088

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8088/health || exit 1

CMD ["node", "dist/server.js"]
