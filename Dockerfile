FROM node:22
ARG SECRETENV_BUNDLE
ARG SECRETENV_KEY
# Build identity (Cloud Build substitutions via --build-arg) — logged at boot
# by lib/build-info.js so a running service always says which code it is.
ARG COMMIT_SHA
ARG BRANCH_NAME
ARG TAG_NAME
ENV BUILD_COMMIT=$COMMIT_SHA BUILD_BRANCH=$BRANCH_NAME BUILD_TAG=$TAG_NAME
EXPOSE $PORT
WORKDIR /usr/src/app
# yarn.lock must be copied too: `package*.json` does NOT match it, so without
# it `yarn install` re-resolves every semver range from scratch and the image
# floats onto whatever is newest at build time — the committed lockfile (and
# every lockfile-only Dependabot patch) has no effect on what actually ships.
# That is how better-auth silently moved 1.6.25 -> 1.7.1 and took its breaking
# `account.issuer` schema change to beta/staging (see
# scripts/auth-issuer-backfill.mjs). --frozen-lockfile makes any drift between
# package.json and yarn.lock fail the build instead of shipping a surprise.
COPY package*.json yarn.lock ./
RUN yarn install --frozen-lockfile
RUN mkdir -p credentials
RUN npx secretenv -r GOOGLE_CREDENTIAL > credentials/google.json
COPY . .
CMD [ "yarn", "start"]