# 本地跑控制台用；连 QQ 建议直接 npm run bot，容器里改配置不方便。
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV QQBOT_DATA_DIR=/app/data
ENV HOST=0.0.0.0
EXPOSE 3210
VOLUME ["/app/data"]
CMD ["node", "src/cli.js", "serve"]
