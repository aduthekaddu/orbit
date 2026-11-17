FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# The build opens the database as root and leaves root-owned files in /app/data.
COPY docker/entrypoint.sh /usr/local/bin/orbit-entrypoint
RUN chmod 755 /usr/local/bin/orbit-entrypoint \
  && rm -rf /app/data \
  && mkdir -p /app/data \
  && chown node:node /app/data

ENV NODE_ENV=production
EXPOSE 3210
USER 1000:1000
ENTRYPOINT ["orbit-entrypoint"]
CMD ["npm", "start", "--", "-p", "3210", "-H", "0.0.0.0"]
