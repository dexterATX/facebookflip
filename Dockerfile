# FlipRadar in Docker. Includes Chromium for the background-browser fallback.
# Works on regular PCs (amd64) and 64-bit Raspberry Pi (arm64).
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit

COPY src ./src
COPY public ./public
COPY tools ./tools

VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "src/server.js"]
