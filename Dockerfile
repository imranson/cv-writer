# syntax=docker/dockerfile:1
# CV Writer — production image for Railway (or any Docker host).
# The Playwright base image ships Chromium + all system libraries for PDF rendering.
# Keep the tag in sync with the exact "playwright" version in package.json.

FROM mcr.microsoft.com/playwright:v1.65.0-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.client.json ./
COPY scripts ./scripts
COPY src ./src
COPY web ./web
RUN NODE_ENV=production npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.65.0-noble AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY skills ./skills
# Run as the image's unprivileged user.
RUN chown -R pwuser:pwuser /app
USER pwuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
