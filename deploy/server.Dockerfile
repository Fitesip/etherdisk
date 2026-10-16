# The Rust backend. Build from the repository root:
#   docker build -f deploy/server.Dockerfile -t etherdisk-server .
FROM rust:1.97-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
RUN cargo build --release --locked -p etherdisk-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home /app etherdisk
WORKDIR /app
COPY --from=build /src/target/release/etherdisk-server /usr/local/bin/etherdisk-server
USER etherdisk
# Behind nginx: listen on all interfaces inside the container; take the client IP from it.
ENV BIND_ADDR=0.0.0.0:8787 TRUST_PROXY=true RUST_LOG=etherdisk_server=info,tower_http=info
EXPOSE 8787
CMD ["etherdisk-server"]
