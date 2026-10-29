# The Next.js app (with the crypto crate compiled to WASM). Build from the repository root:
#   docker build -f deploy/web.Dockerfile --build-arg NEXT_PUBLIC_CHAIN_ID=1 ... -t etherdisk-web .
# NEXT_PUBLIC_* values are baked into the build: rebuild the image to change them.
FROM node:24-bookworm AS build
ARG RUST_VERSION=1.97.1
ARG WASM_PACK_VERSION=v0.15.0
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain $RUST_VERSION --target wasm32-unknown-unknown \
    && curl -sSfL https://github.com/wasm-bindgen/wasm-pack/releases/download/$WASM_PACK_VERSION/wasm-pack-$WASM_PACK_VERSION-x86_64-unknown-linux-musl.tar.gz \
       | tar xz -C /tmp && mv /tmp/wasm-pack-$WASM_PACK_VERSION-x86_64-unknown-linux-musl/wasm-pack /usr/local/bin/
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY web web
# The footer shows the released version, read from the changelog at build time.
COPY CHANGELOG.md ./

ARG NEXT_PUBLIC_CHAIN_ID=11155111
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_RPC_URL
ARG NEXT_PUBLIC_CONTRACT_ADDRESS
ARG NEXT_PUBLIC_WC_PROJECT_ID=
ENV NEXT_PUBLIC_CHAIN_ID=$NEXT_PUBLIC_CHAIN_ID \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL \
    NEXT_PUBLIC_CONTRACT_ADDRESS=$NEXT_PUBLIC_CONTRACT_ADDRESS \
    NEXT_PUBLIC_WC_PROJECT_ID=$NEXT_PUBLIC_WC_PROJECT_ID \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
# `prebuild` compiles the WASM first.
RUN cd web && npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /src/web/.next/standalone ./
COPY --from=build --chown=node:node /src/web/.next/static ./.next/static
COPY --from=build --chown=node:node /src/web/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
