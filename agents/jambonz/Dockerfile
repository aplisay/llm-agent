FROM node:24-alpine
RUN apk add git
ARG SECRETENV_BUNDLE
ARG SECRETENV_KEY
EXPOSE $PORT
WORKDIR /usr/src/app
COPY package*.json ./
RUN yarn install
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