# ── Build stage ──────────────────────────────────────────────────────────────
FROM golang:1.25-bookworm AS builder

WORKDIR /src

# Cache module downloads when only application sources change.
COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal

# CGO stays off: the SQLite driver is pure Go, so the runtime image needs no
# SQLite library and the binary is portable across glibc versions.
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/wildtoken ./cmd/wildtoken

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        locales \
        tzdata \
    && sed -i 's/^# \(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen \
    && locale-gen \
    && ln -snf /usr/share/zoneinfo/Asia/Singapore /etc/localtime \
    && echo 'Asia/Singapore' > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /out/wildtoken /usr/local/bin/wildtoken
COPY static ./static
COPY config ./config

# Themes are runtime-only, so copying them last keeps theme edits from
# invalidating the compile cache.
COPY themes ./themes

ENV APP__SERVER__HOST=0.0.0.0 \
    APP__SERVER__PORT=3100 \
    DATABASE_URL=sqlite:/data/wildtoken.db?mode=rwc \
    WILDTOKEN_LOG=info \
    LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8 \
    TZ=Asia/Singapore

VOLUME ["/data"]
EXPOSE 3100

CMD ["wildtoken"]
