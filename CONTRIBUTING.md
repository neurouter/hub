# Contributing to Neurouter Hub

Thanks for helping. Bug reports, docs fixes and pull requests are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue or a Discussion first so we can agree on the approach.
- Security issues: follow [SECURITY.md](SECURITY.md), never a public issue.
- By contributing you agree your work is licensed under [Apache-2.0](LICENSE) and you follow the
  [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Requirements: Node.js >= 24 and npm 11. No Docker needed: local dev uses SQLite.

```bash
npm ci
cp .env.example .env      # adjust if needed; dev falls back to ephemeral keys
npm run dev               # server + web with hot reload
```

## Checks (CI runs the same)

```bash
npm run lint
npm run typecheck
npm test                  # Vitest unit tests
npm run build
npm run test:e2e          # Playwright; first time: npx playwright install chromium
```

To run the e2e suite against Postgres, set `E2E_DATABASE_URL` to an empty Postgres database with
pgvector available.

## Layout

- `apps/server`: Fastify API and the `/mcp` gateway
- `apps/web`: React admin console and user portal
- `packages/shared`: zod API contract shared by both

## Pull requests

- Keep them focused; include tests for behaviour changes.
- Use [Conventional Commits](https://www.conventionalcommits.org/) style messages (`fix(server): …`).
- Database changes need a migration that works on both SQLite and Postgres.
