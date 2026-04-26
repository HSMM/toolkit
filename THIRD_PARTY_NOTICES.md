# Third-Party Notices

Toolkit is licensed under the Apache License, Version 2.0. The project
uses third-party open-source software, container images, and external
systems that are distributed under their own licenses.

This file is a project-level summary. It does not replace the license
texts, notices, or terms shipped by each upstream project.

## Go Dependencies

The backend uses Go libraries including:

| Component | Upstream | License family |
|---|---|---|
| coder/websocket | github.com/coder/websocket | BSD-style |
| go-chi/chi | github.com/go-chi/chi | MIT |
| go-chi/cors | github.com/go-chi/cors | MIT |
| go-chi/httprate | github.com/go-chi/httprate | MIT |
| golang-jwt/jwt | github.com/golang-jwt/jwt | MIT |
| golang-migrate/migrate | github.com/golang-migrate/migrate | MIT |
| google/uuid | github.com/google/uuid | BSD-style |
| jackc/pgx | github.com/jackc/pgx | MIT |
| golang.org/x/crypto | golang.org/x/crypto | BSD-style |

## Web Dependencies

The frontend uses npm packages including:

| Component | Upstream | License family |
|---|---|---|
| React | react.dev | MIT |
| react-router | reactrouter.com | MIT |
| TanStack Query | tanstack.com/query | MIT |
| i18next | i18next.com | MIT |
| react-i18next | react.i18next.com | MIT |
| lucide-react | lucide.dev | ISC |
| Vite | vite.dev | MIT |
| TypeScript | typescriptlang.org | Apache-2.0 |
| Vitest | vitest.dev | MIT |
| Playwright | playwright.dev | Apache-2.0 |
| openapi-typescript | openapi-ts.dev | MIT |

## Runtime Services And Images

The development and production compose files reference third-party
services and container images, including:

| Component | Purpose | License family |
|---|---|---|
| PostgreSQL | relational database | PostgreSQL License |
| Alpine Linux | base/runtime image | various open-source licenses |
| Go toolchain image | backend build image | BSD-style / image terms |
| Node.js image | frontend build image | MIT / image terms |
| Nginx | reverse proxy/static web server | BSD-style |
| MinIO | S3-compatible object storage | AGPL-3.0 |
| OpenSearch | full-text search | Apache-2.0 |
| Redis | LiveKit Egress coordination | BSD-style |
| LiveKit Server | WebRTC SFU | Apache-2.0 |
| LiveKit Egress | meeting recording | Apache-2.0 |
| coturn | STUN/TURN server | BSD-style |
| Prometheus | metrics | Apache-2.0 |
| Grafana | dashboards and alerting | AGPL-3.0 |
| Loki | log storage | AGPL-3.0 |
| Promtail | log collection | AGPL-3.0 |
| node-exporter | host metrics | Apache-2.0 |
| postgres-exporter | PostgreSQL metrics | Apache-2.0 |

When distributing a built deployment bundle or container image, include
the corresponding upstream notices and license texts for the exact
versions being shipped.

## External Integrations

Toolkit integrates with external systems such as Bitrix24, FreePBX, and
GigaAM ASR. These are not licensed as part of Toolkit. Use of those
systems is governed by their respective licenses, subscriptions, or
internal deployment terms.
