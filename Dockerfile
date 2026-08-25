FROM node:20-slim AS runner

WORKDIR /app

# Copy static files into dist/public (server expects this path)
RUN mkdir -p dist/public
COPY index.html dist/public/
COPY assets dist/public/assets/
COPY config.json dist/public/
COPY success.html dist/public/

# Copy server files
COPY server-complete.js .
COPY package.json .

# Install native build tools for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install better-sqlite3 dotenv --omit=dev

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server-complete.js"]
