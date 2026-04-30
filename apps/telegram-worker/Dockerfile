FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install --no-audit --no-fund
COPY src ./src

ENV TELEGRAM_WORKER_PORT=8090
EXPOSE 8090

CMD ["npm", "start"]
