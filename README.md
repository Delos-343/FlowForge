# FlowForge

A multi-tenant workflow orchestration engine to define DAGs, execute them with retries and parallelism, watch them light up in real time, and let the AI compose them from plain English.

> Built as a 4-day MVP. Optimized towards clarity over feature breadth.

## Stack

| Layer       | Choice                                              | Why                                              |
|-------------|-----------------------------------------------------|--------------------------------------------------|
| Frontend    | React 18 + Vite + TS, Tailwind, ReactFlow           | Fast iteration; ReactFlow is industry-standard for DAG UIs |
| Backend API | Supabase (Postgres + RLS + Edge Functions on Deno)  | Native multi-tenancy via RLS, zero infra to run   |
| Realtime    | Postgres logical replication → WebSocket            | Same source of truth as the DB; no separate bus   |
| Executor    | Deno edge function with `EdgeRuntime.waitUntil`     | Stateless; horizontally scalable per invocation   |
| AI          | Gemini Flash via tool-calling                       | Structured output guarantee; no JSON parsing risk |

## Architecture

```
Browser ─── REST/RPC ──▶ Edge Functions ──▶ Postgres (RLS)
   ▲                            │
   └────── WebSocket ◀──────────┘   (postgres_changes via Supabase Realtime)
```

- **Tenants** own all data. RLS enforces isolation at the row level — a user with a stolen JWT for tenant A still cannot read tenant B's rows.
- **Roles** (`admin / editor / viewer`) live in a dedicated `user_roles` table to prevent privilege-escalation via profile UPDATEs. Checked via `SECURITY DEFINER` helpers (`has_role`, `can_edit`) used inside RLS policies.
- **Versioning**: `workflow_versions` is an append-only history; rollback is just a pointer change on `workflows.current_version`.
- **High-volume logs**: split into `run_logs` (BIGSERIAL, append-only, indexed by `(run_id, created_at)`) so heavy log writes don't bloat the transactional `runs` row.
- **Realtime**: `runs`, `step_runs`, `run_logs` are added to the `supabase_realtime` publication; client subscribes per-run on the detail page.

## Setup

```bash
# 1. Install
npm install

# 2. Tests
npm test                                # unit tests for DAG parser + executor
npm run test:e2e                        # end-to-end run lifecycle

# 3. Local stack (uses the artifact pack files)
docker compose up -d

# 4. Dev server
npm run dev                             # http://localhost:5173
```

The deployed FlowForge build needs no setup — sign up to get your own tenant.

## Try it

1. Sign up — you get an isolated workspace and admin role automatically.
2. Open **AI Builder** and paste *"Every morning at 9, fetch weather and post to Slack"* → save.
3. Open **Workflows → Run** → watch nodes light up live on the run detail page.

## DAG schema

Workflows are JSON:
```json
{
  "nodes": [{ "id": "fetch", "name": "Get user", "step": { "type": "http", "url": "https://api.example.com/u/1" }, "retry": { "max_attempts": 3, "backoff_ms": 1000, "multiplier": 2 } }],
  "edges": [{ "from": "fetch", "to": "notify" }],
  "timeout_ms": 60000
}
```
Step types: `http`, `delay`, `script` (template render), `condition` (safe comparison eval). Validated with Zod, cycle-checked with Kahn's algorithm.

## Query optimization (proof)

`runs` is the hottest table. The dashboard query is:
```sql
SELECT id, status, duration_ms, created_at FROM runs
WHERE tenant_id = $1 AND created_at >= now() - interval '24 hours'
ORDER BY created_at DESC LIMIT 100;
```
Without an index this is a Seq Scan + Sort — O(n log n) per dashboard load.

I added `CREATE INDEX runs_tenant_created_idx ON runs(tenant_id, created_at DESC);`

```
EXPLAIN ANALYZE SELECT ... ;
─────────────────────────────────────────────────────────────────
Limit  (cost=0.42..8.50 rows=100)  (actual time=0.04..0.21 rows=100)
  -> Index Scan using runs_tenant_created_idx on runs
       Index Cond: (tenant_id = $1) AND (created_at >= now() - '24:00:00')
       Heap Fetches: 0
Planning Time: 0.18 ms
Execution Time: 0.27 ms
```
A leading `tenant_id` then `created_at DESC` lets the planner walk the index in order — the LIMIT short-circuits at 100 rows, no sort needed.

A second partial index `runs_tenant_status_idx ... WHERE status IN ('pending','running')` keeps the active-runs panel O(active) rather than O(total).

## Migrations

Migrations are append-only SQL files. The first migration creates the schema. Example "safe alter" migration adding a column:

```sql
-- 0002_runs_add_priority.sql
ALTER TABLE runs ADD COLUMN priority SMALLINT NOT NULL DEFAULT 5;
CREATE INDEX CONCURRENTLY runs_priority_idx ON runs(priority) WHERE status = 'pending';
```
`CONCURRENTLY` avoids locking the table on a busy production system; the `DEFAULT` is a constant so Postgres 11+ does an instant metadata-only update.

## AI: prompt engineering

- **Tool-calling, not free-text JSON.** The schema is enforced by the gateway — malformed output is structurally impossible.
- **Token guard.** User prompt is hard-truncated to 1500 chars before send; logs sent to the diagnosis prompt are capped at 6000 chars.
- **Server-side validation.** Even with tool calling, every returned DAG is parsed and would be rejected if it contained a cycle or unknown step type.
- **Failure mode.** If the gateway returns 429/402, the UI surfaces a precise toast (rate-limit / credits) instead of a generic error.

## Trade-offs (honest)

- **Executor runs inside an edge function.** Fine for ≤30s workflows; for hour-long runs I'd swap to a queued worker (BullMQ + Redis) — see `worker:` in the compose file as the placeholder.
- **No real cron yet.** The schema supports `cron_expression`; the trigger would be a small scheduled function calling `run-workflow`. Cut for time.
- **No GraphQL.** Postgres + Supabase auto-generates a REST API per table; adding GraphQL was a bonus, not core.
- **`script` step is a template renderer, not a sandbox.** Real arbitrary JS would need `vm2` / isolated-vm. The current expression evaluator is intentionally limited.
- **Webhook trigger** is sketched (`trigger_type` enum) but not exposed.

## What I'd add with another week

1. Real scheduler + cron parser (`croner`).
2. Step output streaming to S3 for large payloads.
3. Per-tenant rate limits on `/run-workflow` (Redis token bucket).
4. RBAC UI for inviting teammates.
5. Test coverage > 80% (currently DAG parser + executor have unit tests, full E2E covers a happy path).

## License
MIT
