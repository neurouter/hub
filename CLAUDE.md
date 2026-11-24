# Neurouter — Enterprise MCP Gateway

This is a full rewrite (Phase 1 in progress on `master`). The legacy LLM gateway lives in the private repo `neurouter/neurouter-legacy` (tag `v1.0.0-legacy`).

- `.agent/` is a separate checkout of the private repo `neurouter/internal` (gitignored here): plans, reports, designs, scripts. Plan and decisions: `.agent/reports/2026-11-23-mcp-gateway-plan.md`. Commit reports there, never in this repo.
- Local dev uses SQLite (no Docker required). Production uses Postgres.
- Tests: unit tests only for now (Vitest).
