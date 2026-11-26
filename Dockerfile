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
# breaking `account.issuer` schema change to beta/staging (1.7.3 undid it: see
# relaxAccountIssuer() in lib/database.js). --frozen-lockfile makes any drift between
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
#
# The image holds no settings. docker-compose.ci.yml gives the container
# SECRETENV_BUNDLE and SECRETENV_KEY when it runs, and its command writes
# credentials/google.json from them before the suite starts.
# --------------------------------------------------------------------------
FROM deps AS test
COPY . .
RUN mkdir -p credentials
CMD [ "yarn", "test" ]

# --------------------------------------------------------------------------
# runtime: the deployed image. KEEP THIS STAGE LAST. cloudbuild.yaml,
# cloudbuild-beta.yaml and cloudbuild-feature.yaml all run
# `docker build -f Dockerfile` with no --target, so they get whichever stage
# ends this file. Adding a stage below this one would silently ship it.
#
# SECRETENV_BUNDLE and SECRETENV_KEY are build secrets, not build args:
#   docker build --secret id=SECRETENV_BUNDLE,env=SECRETENV_BUNDLE \
#                --secret id=SECRETENV_KEY,env=SECRETENV_KEY \
#                --build-arg BUILD_ID=<new for each build> ...
# A build arg is copied into the build output and into the image history. A
# secret is in neither. It needs BuildKit (DOCKER_BUILDKIT=1 on older Docker).
#
# `npx secretenv` runs AFTER `COPY . .` so the credentials it writes are
# rebuilt on every commit. credentials/ is gitignored, so the COPY cannot
# clobber the generated file.
#
# A build with no secrets (the public images) writes no credential file at
# all. The server then writes it at start from a GOOGLE_CREDENTIAL env var,
# if one is set (lib/google-credential.js).
# --------------------------------------------------------------------------
FROM deps AS runtime
# Build identity (Cloud Build substitutions via --build-arg), logged at boot
# by lib/build-info.js so a running service always says which code it is.
ARG COMMIT_SHA
ARG BRANCH_NAME
ARG TAG_NAME
ENV BUILD_COMMIT=$COMMIT_SHA BUILD_BRANCH=$BRANCH_NAME BUILD_TAG=$TAG_NAME
EXPOSE $PORT
COPY . .
RUN mkdir -p credentials
# The cache key of a step does not include the value of a secret, or whether
# one was given. It does include BUILD_ID. So a build with the secrets must
# pass a new BUILD_ID: the step then always runs again, and a build without
# the secrets is never served a cached layer that holds a credential.
ARG BUILD_ID
RUN --mount=type=secret,id=SECRETENV_BUNDLE \
    --mount=type=secret,id=SECRETENV_KEY \
    if [ -s /run/secrets/SECRETENV_BUNDLE ]; then \
      if [ -z "$BUILD_ID" ]; then echo "pass --build-arg BUILD_ID=<new value> with the secrets" >&2; exit 1; fi; \
      SECRETENV_BUNDLE="$(cat /run/secrets/SECRETENV_BUNDLE)" \
      SECRETENV_KEY="$(cat /run/secrets/SECRETENV_KEY)" \
      npx secretenv -r GOOGLE_CREDENTIAL > credentials/google.json; \
    fi
# The API imports the LiveKit worker's compiled model registry. Compile it here,
# once, instead of in `prestart` on every container start; prestart skips the
# build when LIVEKIT_WORKER_PREBUILT is set and the output is present.
RUN cd agents/livekit && yarn build
ENV LIVEKIT_WORKER_PREBUILT=1
CMD [ "yarn", "start"]
