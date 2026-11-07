FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

COPY docker/entrypoint.sh /usr/local/bin/orbit-entrypoint
RUN chmod 755 /usr/local/bin/orbit-entrypoint \
  && mkdir -p /app/data \
  && chown node:node /app/data

ENV NODE_ENV=production
EXPOSE 3210
USER node
ENTRYPOINT ["orbit-entrypoint"]
CMD ["npm", "start", "--", "-p", "3210", "-H", "0.0.0.0"]
