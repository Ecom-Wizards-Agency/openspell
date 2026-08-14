FROM node:22-alpine

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.js turbo.json ./
COPY packages ./packages
# `tools/` too: the worker depends on @wizard-ads/crosscheck-cli, and a
# workspace:* link whose target is not in the image fails the frozen install.
COPY tools ./tools
COPY apps/worker ./apps/worker
RUN pnpm install --frozen-lockfile

EXPOSE 3000
CMD ["pnpm", "--filter", "@wizard-ads/worker", "start"]
