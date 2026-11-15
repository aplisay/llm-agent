# voiceblender built from its source at one commit, with nothing added.
#
#   docker build -f engine.Dockerfile --build-arg VOICEBLENDER_COMMIT=<full commit id> .
FROM golang:1.26-alpine AS builder
RUN apk add --no-cache git
ARG VOICEBLENDER_REPO=https://github.com/VoiceBlender/voiceblender
ARG VOICEBLENDER_COMMIT
WORKDIR /src
# The last test fails the build if the fetch gave anything but that commit.
RUN test -n "$VOICEBLENDER_COMMIT" \
 && git init -q . \
 && git remote add origin "$VOICEBLENDER_REPO" \
 && git fetch -q --depth 1 origin "$VOICEBLENDER_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$VOICEBLENDER_COMMIT"
RUN go mod download
RUN CGO_ENABLED=0 go build -ldflags "-X main.version=$VOICEBLENDER_COMMIT" -o /voiceblender ./cmd/voiceblender

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /voiceblender /usr/local/bin/voiceblender
ENTRYPOINT ["voiceblender"]
