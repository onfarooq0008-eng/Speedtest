FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Koyeb injects PORT; default kept for local runs
ENV PORT=8000
EXPOSE 8000

CMD ["node", "server.js"]
