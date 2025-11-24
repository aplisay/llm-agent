FROM node:20-alpine
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
COPY tests/setup tests/setup
RUN yarn test
ENV NODE_ENV production
ENTRYPOINT node index