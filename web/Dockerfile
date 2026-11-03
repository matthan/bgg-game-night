# ---- dev: Vite dev server with hot reload (used by docker-compose) ----
FROM node:22-alpine AS dev
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev"]

# ---- build: static files ----
FROM dev AS build
RUN npm run build

# ---- prod: serve static files with nginx (for ZimaOS later) ----
FROM nginx:1.27-alpine AS prod
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
