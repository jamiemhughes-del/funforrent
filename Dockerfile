FROM node:20-slim AS runner

WORKDIR /app

COPY dist ./dist
COPY server-checkout.js .
COPY .env .env
COPY package.json .

RUN npm install dotenv --omit=dev

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server-checkout.js"]
