FROM node:22-slim
ARG SECRETENV_BUNDLE
ARG SECRETENV_KEY
EXPOSE $PORT
WORKDIR /usr/src/app
RUN apt-get -y update 
RUN apt-get install -y ca-certificates
COPY agents/livekit ./
RUN yarn install
RUN yarn build
RUN rm -f agent-lib
RUN mkdir -p agent-lib
COPY lib agent-lib
ENV NODE_ENV production
ENTRYPOINT node realtime.mjs start