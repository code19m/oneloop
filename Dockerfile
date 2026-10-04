# syntax=docker/dockerfile:1
FROM rust:1.92.0-bookworm AS builder
ARG SOURCE_REVISION=unknown
ENV SOURCE_REVISION=$SOURCE_REVISION
WORKDIR /build
COPY Cargo.toml Cargo.lock build.rs THIRD_PARTY_NOTICES.md ./
COPY src ./src
COPY migrations ./migrations
COPY frontend ./frontend
RUN cargo build --locked --release --bin oneloop

FROM debian:bookworm-slim AS runtime
LABEL org.opencontainers.image.title="oneloop" \
      org.opencontainers.image.description="Lightweight, self-hosted task management for small teams, in a single binary" \
      org.opencontainers.image.source="https://github.com/code19m/oneloop" \
      org.opencontainers.image.url="https://code19m.github.io/oneloop/" \
      org.opencontainers.image.documentation="https://code19m.github.io/oneloop/" \
      org.opencontainers.image.licenses="MIT"
# Git and the SSH client sync Knowledge folders from repository hosts.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata git openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 oneloop \
    && useradd --uid 10001 --gid oneloop --no-create-home --home-dir /data oneloop \
    && install -d -m 0700 -o oneloop -g oneloop /data
COPY --from=builder /build/target/release/oneloop /usr/local/bin/oneloop
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/oneloop/
ENV ONELOOP_DATA_DIR=/data ONELOOP_LISTEN=0.0.0.0:8080
USER 10001:10001
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["oneloop"]
CMD ["serve"]
