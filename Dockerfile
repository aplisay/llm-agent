# syntax=docker/dockerfile:1

# --------------------------------------------------------------------------
# deps: the dependency layer. Both the CI test image and the runtime image
# build FROM this stage, so `yarn install` runs once per build instead of once
# per image, and the test suite runs against the same base (and the same libc)
# the service actually ships on.
#
# yarn.lock must be copied too: `package*.json` does NOT match it, so without
# it `yarn install` re-resolves every semver range from scratch and the image
# floats onto whatever is newest at build time. The committed lockfile (and
# every lockfile-only Dependabot patch) then has no effect on what actually
# ships. That is how better-auth silently moved 1.6.25 to 1.7.1 and took its
# breaking `account.issuer` schema change to beta/staging (see
# scripts/auth-issuer-backfill.mjs). --frozen-lockfile makes any drift between
# package.json and yarn.lock fail the build instead of shipping a surprise.
#
# Nothing in this stage reads a build arg, so the layer is reusable between
# builds: the CI configs pass --cache-from and this stage is a cache hit
# whenever package.json and yarn.lock are unchanged. The lockfile is part of
# the cache key, so a dependency change still forces a real install.
# --------------------------------------------------------------------------
FROM node:22 AS deps
WORKDIR /usr/src/app
COPY package*.json yarn.lock ./
RUN yarn install --frozen-lockfile

# --------------------------------------------------------------------------
# test: the CI test runner. docker-compose.ci.yml builds this target.
# --------------------------------------------------------------------------
FROM deps AS test
ARG SECRETENV_BUNDLE
ARG SECRETENV_KEY
ENV SECRETENV_BUNDLE=$SECRETENV_BUNDLE SECRETENV_KEY=$SECRETENV_KEY
COPY . .
RUN mkdir -p credentials
RUN npx secretenv -r GOOGLE_CREDENTIAL > credentials/google.json
CMD [ "yarn", "test" ]

# --------------------------------------------------------------------------
# runtime: the deployed image. KEEP THIS STAGE LAST. cloudbuild.yaml,
# cloudbuild-beta.yaml and cloudbuild-feature.yaml all run
# `docker build -f Dockerfile` with no --target, so they get whichever stage
# ends this file. Adding a stage below this one would silently ship it.
#
# `npx secretenv` runs AFTER `COPY . .` so the credentials it writes are
# rebuilt on every commit and can never be served from a stale cache layer.
# credentials/ is gitignored, so the COPY cannot clobber the generated file.
# --------------------------------------------------------------------------
FROM deps AS runtime
ARG SECRETENV_BUNDLE
ARG SECRETENV_KEY
# Build identity (Cloud Build substitutions via --build-arg), logged at boot
# by lib/build-info.js so a running service always says which code it is.
ARG COMMIT_SHA
ARG BRANCH_NAME
ARG TAG_NAME
ENV BUILD_COMMIT=$COMMIT_SHA BUILD_BRANCH=$BRANCH_NAME BUILD_TAG=$TAG_NAME
EXPOSE $PORT
COPY . .
RUN mkdir -p credentials
RUN npx secretenv -r GOOGLE_CREDENTIAL > credentials/google.json
CMD [ "yarn", "start"]
