# Development test page: a static page that joins a LiveKit room for an agent.
# Used by the `ui` profile in compose.yaml. Not for public hosts.
FROM node:22-slim AS vendor
WORKDIR /build
RUN npm install --no-save --no-audit --no-fund livekit-client@2.22.4

FROM nginx:1.29-alpine
COPY --from=vendor /build/node_modules/livekit-client/dist/livekit-client.umd.js /usr/share/nginx/html/vendor/livekit-client.umd.js
COPY tools/test-page/index.html tools/test-page/app.js /usr/share/nginx/html/
COPY tools/test-page/default.conf.template /etc/nginx/templates/default.conf.template
ENV API_UPSTREAM=api:4000
EXPOSE 8080
