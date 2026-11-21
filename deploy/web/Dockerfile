FROM node:22-alpine AS build
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM nginx:1.28-alpine
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
# 只发布落地页和素材；说明与核对截图不进镜像
COPY deploy/demo/index.html /usr/share/nginx/html/demo/index.html
COPY deploy/demo/agent-assets/ /usr/share/nginx/html/demo/agent-assets/
