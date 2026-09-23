# ---------- 依赖 ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --cache /tmp/npm-cache

# ---------- 构建静态资源 ----------
FROM deps AS build
COPY . .
RUN npm run build

# ---------- 纯静态站点 ----------
FROM nginx:1.27-alpine AS production
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1/health | grep -q ok || exit 1

# ---------- 一次性复核服务：代码 + 构建 + HTTP 冒烟 ----------
FROM deps AS verify
COPY . .
CMD ["sh", "scripts/verify.sh"]
