FROM directus/directus:11.13.4
USER root

# 1. Install system-level dependencies for building 'sharp'
# vips-dev is the key library sharp needs. build-base provides compilers.
RUN apk add --no-cache vips-dev build-base

# 2. Copy your application code into the image
COPY ./extensions /directus/extensions
COPY ./importer /directus/importer

# 3. Set up PNPM and install Node.js dependencies
# This command chain navigates into the extension folder, runs 'pnpm install',
# which will read your new package.json and install sharp.
RUN corepack enable \
 && corepack prepare pnpm@8.7.6 --activate \
 && cd /directus/extensions \
 && pnpm install \
 && cd /directus/extensions/blurhash \
 && pnpm install --prod \
 && rm -rf /root/.local/share/pnpm/store

# 3.1 Build extensions
ENV PATH="/directus/extensions/node_modules/.bin:$PATH"
RUN cd /directus/extensions/blurhash && pnpm run build
# RUN cd /directus/extensions/armonia && pnpm run build
# RUN cd /directus/extensions/core && pnpm run build
# RUN cd /directus/extensions/cronjobs && pnpm run build
# RUN cd /directus/extensions/integrations && pnpm run build
# RUN cd /directus/extensions/interfaces && pnpm run build
# RUN cd /directus/extensions/meilisearch && pnpm run build
# RUN cd /directus/extensions/report && pnpm run build
# RUN cd /directus/extensions/shop && pnpm run build
  
# 4. Set correct ownership for everything
# This must run AFTER all files are copied and created so node can own them.
RUN chown -R node:node /directus

EXPOSE 8070
USER node

# 5. The CMD remains clean and simple
CMD ["sh", "-c", "node /directus/cli.js bootstrap && node /directus/cli.js start"]