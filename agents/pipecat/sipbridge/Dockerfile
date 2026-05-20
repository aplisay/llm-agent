# syntax=docker/dockerfile:1.7
#
# Two-stage build for the sipbridge.
#
# Stage 1 (builder): Go 1.23 base image, fetch deps with the layer cache,
# CGO disabled so the resulting binary is fully static and the runtime
# image can be distroless. The Phase-A build pulls only pure-Go
# dependencies (sipgo, pion, coder/websocket, rs/zerolog) — Opus support
# in Phase E will likely need cgo + libopus, at which point the runtime
# base switches off distroless.
#
# Stage 2 (runtime): distroless static. ~25 MB final image.

FROM golang:1.24-bookworm AS builder

WORKDIR /src

# Pre-fetch deps with the standard go.mod/go.sum trick so we benefit from
# Docker's layer cache when only the source changes.
COPY agents/pipecat/sipbridge/go.mod agents/pipecat/sipbridge/go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download

COPY agents/pipecat/sipbridge/ .

ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH:-amd64} \
    go build -trimpath \
      -ldflags="-s -w -X main.version=${VERSION}" \
      -o /out/sipbridge \
      ./cmd/sipbridge

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /out/sipbridge /sipbridge

# REST API port (default). Override via SIPBRIDGE_API_BIND_ADDR.
EXPOSE 8090/tcp
# SIP signalling (default). Override via SIPBRIDGE_SIP_SIGNAL_PORT.
EXPOSE 5060/udp
# RTP range default (10000-20000 UDP).
EXPOSE 10000-20000/udp

USER nonroot:nonroot
ENTRYPOINT ["/sipbridge"]
