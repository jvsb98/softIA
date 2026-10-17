# syntax=docker/dockerfile:1.7
# =====================================================================
#  Nimber Atende — imagem do servidor (Linux / DigitalOcean)
#  Build (na raiz do repositório):
#    docker build -f deploy/docker/Dockerfile -t nimber-atende .
# =====================================================================

# ---------- 1. build: compila web + servidor e monta o pacote de produção
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY patches patches
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && node scripts/package-server.mjs

# ---------- 2. runtime: só o necessário para rodar
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NIMBER_CONFIG_DIR=/config \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app
COPY --from=build --chown=node:node /src/out/nimber-atende/server ./server
COPY --from=build --chown=node:node /src/out/nimber-atende/config-exemplo ./config-exemplo
# /config: master.key (se não vier por NIMBER_MASTER_KEY), database.txt opcional, certificado do banco
# /data:   logs e arquivos temporários
RUN mkdir -p /config /data && chown node:node /config /data
USER node

VOLUME ["/config", "/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "server/dist/index.js"]
