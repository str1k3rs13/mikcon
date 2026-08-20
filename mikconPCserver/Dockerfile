# Build from the GitHub repo root:
#   docker build -f mikconPCserver/Dockerfile .
FROM node:22-bookworm-slim
WORKDIR /opt/mikcon/mikconPCserver
COPY mikconPCserver/package.json mikconPCserver/package-lock.json ./
RUN npm install --omit=dev
COPY mikconPCserver/ ./
COPY juanfi-app/www /opt/mikcon/juanfi-app/www
RUN node scripts/sync-web.mjs
ENV PORT=8787
ENV MIKCON_DATA=/data
EXPOSE 8787
VOLUME ["/data"]
CMD ["node", "server.mjs"]
