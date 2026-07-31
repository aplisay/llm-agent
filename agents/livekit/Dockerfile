FROM node:24-slim
# No SECRETENV_* build args: this image contains no secrets. The pair is read
# from Secret Manager at container start (entrypoint.sh -> load-secretenv.js),
# which is also where credentials/google.json now comes from — it used to be
# decrypted here at build time, putting a live service-account private key in a
# registry layer for anyone with pull access.
EXPOSE $PORT
WORKDIR /usr/src/app
RUN apt-get -y update 
RUN apt-get install -y ca-certificates git
COPY agents/livekit ./
COPY lib/* ./agent-lib/
RUN npm install -g pnpm@latest-10
RUN yarn install --development
RUN yarn build
ENV NODE_ENV production
RUN chmod +x entrypoint.sh
# entrypoint.sh loads the SECRETENV pair from Secret Manager (see
# load-secretenv.js) and then execs `node dist/realtime.js "$@"`, so the agent
# is still PID 1 and still takes its subcommand from CMD. This also replaces
# the old ENTRYPOINT's dist/realtime.mjs, a path tsup has never emitted.
ENTRYPOINT ["/bin/sh", "/usr/src/app/entrypoint.sh"]
CMD ["start"]