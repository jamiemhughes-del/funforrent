FROM node:20-slim AS runner

WORKDIR /app

COPY dist ./dist
COPY server-complete.js .
COPY .env .env
COPY package.json .

# Install native build tools for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install better-sqlite3 dotenv --omit=dev

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server-complete.js"]
