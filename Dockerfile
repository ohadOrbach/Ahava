FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Jerusalem
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV DB_PATH=/data/ahava.db PORT=3000
EXPOSE 3000
CMD ["node", "--no-warnings=ExperimentalWarning", "--import", "tsx", "src/server.ts"]
