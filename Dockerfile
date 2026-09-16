FROM oven/bun:1.2-alpine

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile || bun install --production

COPY index.html social.html manifest.webmanifest ./
COPY js/ ./js/
COPY assets/ ./assets/
COPY src/ ./src/

ENV PORT=80
ENV WORD5_DB_PATH=/data/word5.sqlite
RUN mkdir -p /data

EXPOSE 80

CMD ["bun", "run", "start"]
