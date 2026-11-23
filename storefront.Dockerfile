# syntax=docker/dockerfile:1
# Mercur marketplace storefront (apps/storefront) — Neson fork,
# phase 19-4.
#
# Two stages:
#   build   — bun 1.3.8 (the repo's packageManager) installs the
#             workspace; turbo builds the storefront's workspace deps
#             (@mercurjs/types -> @mercurjs/client -> ...); `next
#             build` itself runs under a REAL node (apt). The
#             oven/bun image's `node` is bun's compatibility shim, and
#             Next 16's Turbopack build crashes through it ("Expected
#             CommonJS module to have a function wrapper" — a bug in
#             bun's loading of Next's precompiled CJS runtime). The
#             NEXT_PUBLIC_* values are BAKED IN at build time:
#             site name/description (Neson branding), the Medusa
#             publishable key (public by design), the default region,
#             the public base URL (SEO/hreflang) and the vendor panel
#             URL.
#
#   The build must NOT point MEDUSA_BACKEND_URL at a live backend:
#   the catalog reads are 'use cache' (cacheLife max), so whatever the
#   prerender sees at build time is replayed to every visitor until an
#   explicit revalidation. A live backend at build time made the
#   listing pages bake in build-time state (and a flaky prerender
#   bake in an empty list that never self-heals). With the default
#   unreachable URL the prerender takes the designed fallback path
#   (cacheFailedRead, revalidates in a minute) and the deploy MUST
#   then POST /api/revalidate (tags: products/regions/categories/
#   collections) — the e2e does this right after rollout.
#   generateStaticParams() degrades to the default region when the
#   backend is unreachable at build time.
#   runtime — node:24-slim running the Next standalone server.
#
# Build (from the mercur/ fork root):
#   docker build -f storefront.Dockerfile \
#     -t <registry>/neson/storefront:<tag> \
#     --build-arg NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_... \
#     --build-arg NEXT_PUBLIC_BASE_URL=http://<node>:31098 \
#     --build-arg NEXT_PUBLIC_VENDOR_URL=http://<node>:31099/seller \
#     --build-arg NEXT_PUBLIC_STRIPE_KEY=pk_test_... .
#
# Runtime env (the pod): MEDUSA_BACKEND_URL (in-cluster mercur svc),
# BRIDGE_URL (in-cluster bridge svc — the consumer login rail),
# REVALIDATE_SECRET, and COOKIE_SECURE=1 only behind TLS (staging is
# plain HTTP; a Secure cookie set over HTTP is dropped by the browser).

FROM oven/bun:1.3.8 AS build
WORKDIR /app
COPY . .
RUN bun install
# A real node for `next build` (see the header: the image's `node`
# is bun's shim, and the Turbopack build crashes through it).
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

ARG NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_BASE_URL
ARG NEXT_PUBLIC_DEFAULT_REGION=us
ARG NEXT_PUBLIC_SITE_NAME=Neson
ARG NEXT_PUBLIC_SITE_DESCRIPTION="The Neson marketplace"
ARG NEXT_PUBLIC_STRIPE_KEY
ARG NEXT_PUBLIC_VENDOR_URL
# Default stays unreachable (see the header): the prerendered catalog
# cache must not capture live build-time state.
ARG MEDUSA_BACKEND_URL=http://localhost:9000
ENV NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=$NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY \
    NEXT_PUBLIC_BASE_URL=$NEXT_PUBLIC_BASE_URL \
    NEXT_PUBLIC_DEFAULT_REGION=$NEXT_PUBLIC_DEFAULT_REGION \
    NEXT_PUBLIC_SITE_NAME=$NEXT_PUBLIC_SITE_NAME \
    NEXT_PUBLIC_SITE_DESCRIPTION=$NEXT_PUBLIC_SITE_DESCRIPTION \
    NEXT_PUBLIC_STRIPE_KEY=$NEXT_PUBLIC_STRIPE_KEY \
    NEXT_PUBLIC_VENDOR_URL=$NEXT_PUBLIC_VENDOR_URL \
    MEDUSA_BACKEND_URL=$MEDUSA_BACKEND_URL
# The storefront's own build script is `next build`, which turbo
# would run through bun (the packageManager) — and that is exactly
# what crashes (the shim above). So, image-locally (not in the repo),
# repoint the script at the real node with an absolute next path and
# let turbo build the whole storefront subtree (deps + the app).
RUN cd apps/storefront \
    && NEXT_DIR="$( [ -d node_modules/next ] && echo node_modules/next \
                    || echo ../../node_modules/next )" \
    && ABS="$(cd "$NEXT_DIR" && pwd)" \
    && sed -i "s#\"build\": \"next build\"#\"build\": \"node $ABS/dist/bin/next build\"#" package.json \
    && bunx turbo run build --filter=@mercurjs/storefront...

FROM node:24-slim
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# output: "standalone" mirrors the monorepo layout for workspaces —
# the server entry is .next/standalone/apps/storefront/server.js.
COPY --from=build /app/apps/storefront/.next/standalone /app
COPY --from=build /app/apps/storefront/.next/static /app/apps/storefront/.next/static
COPY --from=build /app/apps/storefront/public /app/apps/storefront/public
EXPOSE 3000
CMD ["node", "apps/storefront/server.js"]
