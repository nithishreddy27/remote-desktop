FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js ./
ENV NODE_ENV=production TRUST_PROXY=1
EXPOSE 8080
USER node
CMD ["node", "index.js"]
