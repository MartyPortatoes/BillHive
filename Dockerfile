FROM node:20-alpine

# Native build deps for better-sqlite3, plus su-exec for safe privilege drop
RUN apk add --no-cache python3 make g++ su-exec

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY server.js .
COPY email.js .
COPY emailTemplate.js .
COPY index.html ./public/

# /data is the SQLite volume mount. Initial ownership is set here so a fresh
# named volume inherits it; the entrypoint re-applies chown on each start to
# also handle upgrades from older root-owned volumes and host bind-mounts.
RUN mkdir -p /data && chown -R node:node /data /app

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080

# Entrypoint runs as root just long enough to fix /data ownership, then exec's
# the app as the non-root `node` user via su-exec.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
