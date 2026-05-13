# FreeSWITCH image for the Pipecat agent stack.
#
# Built on the aplisay-b2bua base image (rjp44/b2bua-freeswitch:latest) which
# already ships a working FreeSWITCH with the libraries we need. We layer
# mod_audio_stream (https://github.com/voxcom-us/mod_audio_stream) on top — that
# module is the WebSocket bridge between FreeSWITCH and the Pipecat worker.
#
# The same Dockerfile.baseimage from aplisay-b2bua can be used to build the base
# from scratch if rebuilding is preferred.
ARG BUILD_ENV=production
FROM rjp44/b2bua-freeswitch:latest AS fs-base

# ---- Build mod_audio_stream ----
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        git \
        cmake \
        build-essential \
        pkg-config \
        libssl-dev \
        libwebsockets-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# Pin the upstream voxcom-us mod_audio_stream to a known commit. The module
# builds out-of-tree against the installed FreeSWITCH headers.
ARG MOD_AUDIO_STREAM_REF=main
RUN git clone https://github.com/voxcom-us/mod_audio_stream.git /usr/src/mod_audio_stream \
    && cd /usr/src/mod_audio_stream \
    && git checkout ${MOD_AUDIO_STREAM_REF} \
    && mkdir -p build \
    && cd build \
    && cmake .. -DCMAKE_BUILD_TYPE=Release \
    && make -j"$(nproc)" \
    && make install

# Ports
# SIP
EXPOSE 5060/tcp 5060/udp 5061/tcp
# ESL
EXPOSE 8021/tcp
# RTP media
EXPOSE 16384-16484/udp

# Configuration (clean slate — we ship our own minimal conf, mod_audio_stream-only).
RUN rm -rf /usr/local/freeswitch/conf/*
COPY conf/ /usr/local/freeswitch/conf/

COPY entrypoint.sh healthcheck.sh /usr/bin/
RUN chmod +x /usr/bin/entrypoint.sh /usr/bin/healthcheck.sh

# Ensure runtime dirs are writable by the freeswitch user.
RUN chown -R freeswitch:freeswitch /usr/local/freeswitch/run /usr/local/freeswitch/log /usr/local/freeswitch/db

ENTRYPOINT ["/usr/bin/entrypoint.sh"]
