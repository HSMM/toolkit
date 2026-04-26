## Toolkit web — multi-stage build.
## Build: vite собирает SPA в /dist.
## Runtime: nginx раздаёт статику; маршрутизация SPA → /index.html (history mode).

FROM node:20-alpine AS build

WORKDIR /src

# Build-time env для Vite (VITE_* инлайнится в bundle на сборке).
# Прокидываются через docker-compose `build.args` либо CLI `--build-arg`.
ARG VITE_LOGO_URL
ENV VITE_LOGO_URL=$VITE_LOGO_URL

COPY package.json package-lock.json* ./
RUN npm ci || npm install --no-audit --no-fund

COPY . ./
RUN npm run build

FROM nginx:1.27-alpine

# SPA fallback — все роуты отдают index.html, бэкенд проксируется внешним nginx (см. ops/nginx).
RUN printf 'server {\n\
  listen 80;\n\
  root /usr/share/nginx/html;\n\
  index index.html;\n\
  location / { try_files $uri /index.html; }\n\
  location ~* \\.(js|css|svg|png|jpg|woff2?)$ {\n\
    expires 7d;\n\
    add_header Cache-Control "public, immutable";\n\
  }\n\
}\n' > /etc/nginx/conf.d/default.conf

COPY --from=build /src/dist /usr/share/nginx/html
