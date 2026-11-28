# syntax=docker/dockerfile:1
FROM node:24-alpine
RUN apk add git
EXPOSE $PORT
WORKDIR /usr/src/app
# Build context is the repo ROOT (`docker build -f agents/jambonz/Dockerfile .`),
# so `package*.json` here is the root manifest, not agents/jambonz's — and that
# is load-bearing: this image's code, including the shared `lib` copied to
# agent-lib below, imports better-auth, express, openai, @google/genai and
# @modelcontextprotocol/sdk, none of which agents/jambonz/package.json declares.
# agents/jambonz/package.json and its yarn.lock land later via `COPY agents/jambonz .`,
# after node_modules is already built, and are not what gets installed.
#
# yarn.lock must be copied alongside it: `package*.json` does NOT match it, so
# without it `yarn install` re-resolved every semver range at build time and the
# image floated onto whatever was newest on npm. That is how better-auth silently
# moved 1.6.25 -> 1.7.1 in the main image and took its breaking `account.issuer`
# schema change to beta/staging. --frozen-lockfile makes any future drift between
# package.json and yarn.lock fail the build instead of shipping a surprise.
COPY package*.json yarn.lock ./
RUN yarn install --frozen-lockfile
RUN mkdir -p credentials
# SECRETENV_BUNDLE and SECRETENV_KEY are build secrets, not build args:
#   docker build --secret id=SECRETENV_BUNDLE,env=SECRETENV_BUNDLE \
#                --secret id=SECRETENV_KEY,env=SECRETENV_KEY \
#                --build-arg BUILD_ID=<new for each build> ...
# This step and the test step read them from secret mounts under /run/secrets.
# Secret mounts need BuildKit (DOCKER_BUILDKIT=1 on older Docker).
#
# The cache key of a step does not include the value of a secret, or whether
# one was given. It does include BUILD_ID. So a build with the secrets must
# pass a new BUILD_ID: both steps then always run again.
ARG BUILD_ID
RUN --mount=type=secret,id=SECRETENV_BUNDLE \
    --mount=type=secret,id=SECRETENV_KEY \
    if [ -s /run/secrets/SECRETENV_BUNDLE ]; then \
      if [ -z "$BUILD_ID" ]; then echo "pass --build-arg BUILD_ID=<new value> with the secrets" >&2; exit 1; fi; \
      SECRETENV_BUNDLE="$(cat /run/secrets/SECRETENV_BUNDLE)" \
      SECRETENV_KEY="$(cat /run/secrets/SECRETENV_KEY)" \
      npx secretenv -r GOOGLE_CREDENTIAL > credentials/google.json; \
    fi
COPY agents/jambonz .
RUN rm -f agent-lib
RUN rm -f tests/setup
RUN mkdir -p agent-lib
RUN mkdir -p tests/setup
COPY lib agent-lib
# agent-lib/models/livekit.js statically imports the LiveKit agent's *compiled*
# registry from agents/livekit/dist, which is not part of this image. Until the
# shared lib/models/livekit.js is made self-contained (aplisay/llm-agent#123),
# vendor a copy at the exact path the import expects.
COPY agents/jambonz/vendor/livekit-model-registry.js agents/livekit/dist/lib/livekit-model-registry.js
COPY tests/setup tests/setup
# The tests read their settings from the same two secrets.
RUN --mount=type=secret,id=SECRETENV_BUNDLE \
    --mount=type=secret,id=SECRETENV_KEY \
    if [ -s /run/secrets/SECRETENV_BUNDLE ]; then \
      export SECRETENV_BUNDLE="$(cat /run/secrets/SECRETENV_BUNDLE)"; \
      export SECRETENV_KEY="$(cat /run/secrets/SECRETENV_KEY)"; \
    fi; \
    yarn test
ENV NODE_ENV production
ENTRYPOINT node index