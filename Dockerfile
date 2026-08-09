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
COPY package*.json ./
RUN yarn install
RUN mkdir -p credentials
RUN npx secretenv -r GOOGLE_CREDENTIAL > credentials/google.json
COPY . .
CMD [ "yarn", "start"]