FROM node:22
ARG SECRETENV_BUNDLE
ARG SECRETENV_KEY
EXPOSE $PORT
WORKDIR /usr/src/app
COPY package*.json ./
RUN yarn install
RUN mkdir -p credentials
RUN npx secretenv -r GOOGLE_CREDENTIAL > credentials/google.json
COPY . .
RUN chmod +x deploy/docker-entrypoint.sh
# Entrypoint runs the fenced better-auth satellite-table migrate, then `yarn start`.
CMD [ "./deploy/docker-entrypoint.sh" ]