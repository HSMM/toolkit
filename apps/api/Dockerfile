# Toolkit backend — multi-stage build.
# Один бинарник, запускается в режимах api | worker | migrate.

FROM golang:1.23-alpine AS build

WORKDIR /src

# Кэшируем зависимости
COPY go.mod go.sum* ./
RUN go mod download || true

COPY . ./
RUN go mod tidy

RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w" \
    -o /out/toolkit \
    ./cmd/toolkit

FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -S toolkit && adduser -S -G toolkit -u 10001 toolkit

WORKDIR /app
COPY --from=build /out/toolkit /usr/local/bin/toolkit

USER toolkit

ENTRYPOINT ["/usr/local/bin/toolkit"]
CMD ["api"]
