# syntax=docker/dockerfile:1
# Mercur marketplace API (apps/api) — Neson fork, phase 19.
#
# Two stages:
#   build   — bun 1.3.8 (the repo's packageManager) installs the
#             workspace and builds apps/api's @mercurjs/* workspace
#             dependencies (turbo, topological: cli -> types -> core ->
#             stripe-connector). The plugins' exports point at
#             .medusa/server (tsc output), so the app cannot boot
#             without the builds.
#   runtime — node:24-slim. `medusa start` compiles apps/api on the fly
#             (the app has no build step of its own); only node and the
#             installed tree are needed at runtime. Note: bun keeps a
#             workspace package's own deps (incl. @medusajs/cli) in the
#             package's local node_modules, so the CLI bin lives at
#             apps/api/node_modules/.bin/medusa, NOT the root .bin (an
#             npm install would hoist it there — the layout differs).
#
# Build (from the mercur/ fork root):
#   docker build -t <registry>/neson/marketplace:<tag> .
#
# The entrypoint serves /store /admin /vendor + the API on :9000
# (Medusa's default port; the fixture's NodePort maps onto it).

FROM oven/bun:1.3.8 AS build
WORKDIR /app
COPY . .
RUN bun install
RUN bunx turbo run build --filter=@acme/api...

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
EXPOSE 9000
CMD ["sh", "-c", "cd /app/apps/api && exec ./node_modules/.bin/medusa start"]
