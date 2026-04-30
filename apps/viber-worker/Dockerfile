FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install --no-audit --no-fund
COPY src ./src

ENV VIBER_WORKER_PORT=8091
ENV VIBER_PROFILE_DIR=/data/profiles
EXPOSE 8091

CMD ["npm", "start"]
