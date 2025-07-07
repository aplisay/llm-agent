FROM node:22
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm i -g corepack@latest && corepack enable
ARG SECRETENV_BUNDLE
ARG SECRETENV_KEY
EXPOSE $PORT
WORKDIR /usr/src/app
COPY package*.json ./
RUN git clone --single-branch --branch ultravox https://github.com/aplisay/agents-js.git
RUN 
RUN cd agents-js && pnpm install && pnpm build
RUN cd agents-js/agents && yarn link
RUN cd agents-js/plugins/ultravox && yarn link
RUN cd agents-js/plugins/openai && yarn link
RUN yarn link "@livekit/agents"
RUN yarn link "@livekit/agents-plugin-ultravox"
RUN yarn link "@livekit/agents-plugin-openai"
RUN yarn install
RUN mkdir -p credentials
RUN npx secretenv -r GOOGLE_CREDENTIAL > credentials/google.json
COPY . .
RUN yarn test
CMD [ "yarn", "start"]