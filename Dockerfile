# Runs the eSIMfly MCP server over stdio. Credentials come from the environment:
#   docker run -i --rm -e ESIMFLY_ACCESS_CODE=esf_... -e ESIMFLY_SECRET_KEY=sk_... esimfly-mcp
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node", "dist/index.js"]
