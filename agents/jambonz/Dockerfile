FROM node:24-alpine
RUN apk add git
ARG SECRETENV_BUNDLE
ARG SECRETENV_KEY
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
RUN npx secretenv -r GOOGLE_CREDENTIAL > credentials/google.json
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
RUN yarn test
ENV NODE_ENV production
ENTRYPOINT node index