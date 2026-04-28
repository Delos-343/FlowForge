# Code Review — `retry_executor.ts`

## Summary
Net assessment: ❌ **Request changes.** The retry loop has a race condition, leaks an unbounded number of timers under load, swallows errors silently, and ships an unscoped tenant query that breaks our multi-tenant isolation guarantee. Several items are blocking before merge.

---

## Blocking issues

### 1. Tenant isolation broken — `SELECT * FROM workflows WHERE id = ?`
**File:** `src/executor.ts` L42
The query does not include `tenant_id`. A malformed or malicious request could load any tenant's workflow if the caller knows (or guesses) the UUID. **All tenant-scoped queries must include `tenant_id` even when the id is a UUID** — defense in depth, and it makes the index actually useful.
```ts
// Suggested:
.eq("id", workflow_id).eq("tenant_id", auth.tenant_id)
```

### 2. Race condition on `attempt++`
The shared counter is mutated from multiple `setTimeout` callbacks fired in parallel for the same step. Use a per-attempt local variable inside `withRetry`, not a closed-over `let`.

### 3. Errors silently swallowed
```ts
try { await runStep(node); }
catch { /* ignore */ }
```
A failing step is recorded as `success`. At minimum: log the error, mark the step `failed`, and propagate so the global run status is correct. Tests would have caught this — I don't see one for the failure path.

### 4. Unbounded `setTimeout` accumulation
Backoff is implemented with `setTimeout` inside a `for` loop without `await`. On a stuck step you spawn 10 concurrent timers. Use `await new Promise(r => setTimeout(r, delay))` and clear timers on cancellation.

---

## Non-blocking, but please fix

- **Magic numbers** — `if (attempt > 5)` should reference the configured `max_attempts`.
- **Logging** — `console.log("doing thing")` is not actionable. Include `run_id`, `step_key`, and structured fields.
- **No timeout on outbound `fetch`** — a hung downstream will hold the worker indefinitely. Wrap with `AbortController`.
- **Unbounded log payload** — `output: JSON.stringify(result)` can be megabytes. Cap the persisted size and link to S3 if needed.
- **Naming** — `doStuff()`, `helperFn2()` — please rename to describe intent.
- **Missing types** — `function execute(node: any, ctx: any): any` defeats the purpose of TS. Use the `Step` discriminated union.

## Nits
- Prefer `for...of` over `forEach` when the body is async.
- `// TODO: handle this case` left in a hot path — please file a ticket and link.
- Test file is named `executor.test.ts` but only exercises the happy path. Add: retry-then-success, retry-then-fail, timeout, cycle, and a parallel-layer test.

## Things I liked
- DAG layer parallelism is clean and easy to reason about.
- Good use of a sealed step discriminator at the schema layer.
- Migration includes `IF NOT EXISTS` and is replayable.

LGTM once 1–4 are addressed. Happy to pair on the cancellation logic if helpful.
