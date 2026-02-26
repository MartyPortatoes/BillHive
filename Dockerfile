FROM node:20-alpine

# Native build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY server.js .
COPY email.js .
COPY emailTemplate.js .
COPY index.html ./public/

RUN mkdir -p /data

EXPOSE 8080

CMD ["node", "server.js"]
