FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY .wildtoken.bin /usr/local/bin/wildtoken
COPY static ./static
COPY config ./config

ENV APP__SERVER__HOST=0.0.0.0 \
    APP__SERVER__PORT=3100 \
    DATABASE_URL=sqlite:/data/wildtoken.db?mode=rwc \
    RUST_LOG=info

VOLUME ["/data"]
EXPOSE 3100

CMD ["wildtoken"]
