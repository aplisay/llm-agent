FROM node:20-alpine
ARG SECRETENV_BUNDLE
ARG SECRETENV_KEY
EXPOSE $PORT
WORKDIR /usr/src/app
COPY agents/livekit ./
RUN ls -lR
RUN yarn install
RUN yarn build
RUN rm -f agent-lib
RUN mkdir -p agent-lib
COPY lib agent-lib
ENV NODE_ENV production
ENTRYPOINT node realtime.mjs start