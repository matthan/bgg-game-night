# ---- dev: hot-reload with tsx (used by docker-compose) ----
FROM node:22-alpine AS dev
WORKDIR /app
# node:sqlite (built into Node 22) prints an "experimental" notice; hide it
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3001
CMD ["npm", "run", "dev"]

# ---- build: compile TypeScript ----
FROM dev AS build
RUN npm run build

# ---- prod: small image for ZimaOS later ----
FROM node:22-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY mock ./mock
# The SQLite database lives here — mount a volume so it survives updates.
VOLUME /app/data
EXPOSE 3001
CMD ["node", "dist/index.js"]
