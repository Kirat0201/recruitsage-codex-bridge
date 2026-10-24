FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/cloud ./src/cloud
EXPOSE 3000
CMD ["node", "src/cloud/server.mjs"]
