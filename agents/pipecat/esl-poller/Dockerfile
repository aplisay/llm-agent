FROM node:22-alpine AS builder
RUN apk update && apk add yarn git

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install

COPY tsconfig.json jest.config.js ./
COPY src ./src

RUN yarn test

RUN yarn build && yarn cache clean

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]


