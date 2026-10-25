FROM node:24-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.27-alpine AS go
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
RUN CGO_ENABLED=0 go build -trimpath -o /ocms ./cmd/ocms

FROM alpine:3.24
RUN apk add --no-cache ca-certificates ffmpeg poppler-utils tesseract-ocr tesseract-ocr-data-eng tesseract-ocr-data-jpn chromaprint espeak-ng font-dejavu && adduser -D -u 10001 app
COPY --from=go /ocms /usr/local/bin/ocms
COPY --from=web /web/dist /app/web
COPY migrations/ /app/migrations/
USER app
ENV WEB_DIR=/app/web MIGRATIONS_DIR=/app/migrations
ENTRYPOINT ["ocms"]
