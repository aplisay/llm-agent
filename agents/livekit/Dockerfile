FROM node:24-slim
# Load credentials at container start via entrypoint.sh; build-time decryption puts private keys in image layers.
# See agents/livekit/deploy/gcp/README.md.
EXPOSE $PORT
WORKDIR /usr/src/app
RUN apt-get -y update 
RUN apt-get install -y ca-certificates git
COPY agents/livekit ./
COPY lib/* ./agent-lib/
RUN npm install -g pnpm@latest-10
# Fail on lockfile drift so image builds cannot silently change dependency versions. See PR #229.
RUN yarn install --development --frozen-lockfile
RUN yarn build
ENV NODE_ENV production
RUN chmod +x entrypoint.sh
# entrypoint.sh loads the SECRETENV pair from Secret Manager (see
# load-secretenv.js) and then execs `node dist/realtime.js "$@"`, so the agent
# is still PID 1 and still takes its subcommand from CMD. This also replaces
# the old ENTRYPOINT's dist/realtime.mjs, a path tsup has never emitted.
ENTRYPOINT ["/bin/sh", "/usr/src/app/entrypoint.sh"]
CMD ["start"]