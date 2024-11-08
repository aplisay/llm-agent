# Really simple Dockerfile to build a production container which listens on port 80
FROM node:20-alpine
EXPOSE $PORT
WORKDIR /usr/src/app
COPY package*.json ./
RUN yarn install
COPY . .
RUN yarn test
CMD [ "yarn", "start"]