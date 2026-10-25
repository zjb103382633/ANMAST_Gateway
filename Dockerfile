# syntax=docker/dockerfile:1
# ANMAST Gateway —— 多阶段构建：
#   build 阶段编译 server (tsc) 与 web (vite)，运行阶段仅带生产依赖 + python3（ucomp 自动压缩用）

# ---------- 构建阶段 ----------
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
# 先拷贝依赖清单单独安装，最大化利用层缓存
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile

COPY server/ ./server/
COPY web/ ./web/
# server/tsconfig.json 继承根目录的 tsconfig.base.json
COPY tsconfig.base.json ./
RUN pnpm build

# ---------- 运行阶段 ----------
FROM node:24-alpine
# ucomp 自动压缩需要 python3（≥3.10，纯标准库）
RUN apk add --no-cache python3
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    DATA_DIR=/data \
    WEB_DIST=/app/web/dist \
    UCOMP_HOME=/app/server/vendor \
    UCOMP_PYTHON=python3
VOLUME /data
WORKDIR /app

# 生产依赖（仅 server 包；web 的依赖只在构建期需要）
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json ./server/
RUN corepack enable && pnpm install --prod --frozen-lockfile --filter @anmast/server

# 编译产物 + ucomp 桥接 + 前端静态资源
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/vendor ./server/vendor
COPY --from=build /app/web/dist ./web/dist

EXPOSE 4000
WORKDIR /app/server
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/" || exit 1
CMD ["node", "dist/index.js"]
