FROM node:22-slim
ARG SECRETENV_BUNDLE
ARG SECRETENV_KEY
EXPOSE $PORT
WORKDIR /usr/src/app
RUN apt-get -y update 
RUN apt-get install -y ca-certificates git
COPY agents/livekit ./
RUN npm install -g pnpm@latest-10
RUN yarn install
RUN yarn build
ENV NODE_ENV production
ENTRYPOINT node realtime.mjs start