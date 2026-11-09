# syntax=docker/dockerfile:1
# recovery.fiber.so for AWS ECS (infra: fiber-infrastructure/infra/environments/prod/recovery).
# Builds exactly like .github/workflows/release.yml (same Bun, frozen lockfile, no install scripts), so
# the served dist/index.html is byte-identical to the released one; the deploy job records its SHA-256.

FROM oven/bun:1.4.4-slim AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
# package.json overrides point unused dependencies at these local shims.
COPY shims ./shims
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun run build && sha256sum dist/index.html

# nginx running unprivileged (no root, listens on 8080); ECS adds a read-only root filesystem with a
# writable /tmp, where this image keeps its pid and temp files.
FROM nginxinc/nginx-unprivileged:1.29.3-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/index.html /usr/share/nginx/html/index.html
EXPOSE 8080
