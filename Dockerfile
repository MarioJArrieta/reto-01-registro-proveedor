FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN addgroup -S app && adduser -S app -G app && mkdir -p out && chown -R app:app out
USER app
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
