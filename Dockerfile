# Build the client, then run the server with production dependencies only.
# Node 24 runs the TypeScript sources directly (type stripping), so there is no server build step.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 TRUST_PROXY=1 LOG_DIR=/data/logs
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src ./src
COPY data/categories ./data/categories
RUN mkdir -p /data/logs && chown -R node:node /data
USER node
EXPOSE 8080
CMD ["node", "src/server/main.ts"]
