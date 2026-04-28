# Git History for the FlowForge project

The project build doesn't expose git directly, but the recommended commit
sequence (atomic, meaningful) for replaying this work into your own repo:

```
* feat(infra): add Dockerfile, docker-compose, GitHub Actions CI
* docs: README, REVIEW.md, infrastructure design
* feat(ai): natural-language workflow builder via Gemini Flash tool-calling
* feat(ui): real-time run detail with live DAG status + logs
* feat(ui): visual DAG renderer (ReactFlow), workflow editor + version rollback
* feat(ui): dashboard with 24h health metrics
* feat(api): workflow versioning + RBAC enforcement in RLS
* feat(executor): DAG executor edge function (parallel layers, retries, timeout)
* feat(core): DAG schema + Zod validation + topological layering
* feat(auth): email + Google sign-in, tenant bootstrap on signup
* feat(db): multi-tenant schema with RLS, run history, append-only logs
* chore: project bootstrap (Vite + React + Tailwind design system)
```

## Suggested PR (feature branch → main)

**Title:** feat(ai): natural-language workflow builder

**Body:**
> Adds an AI Builder page that turns plain English into a validated FlowForge DAG.
>
> **What**
> - New `ai-build-workflow` edge function — uses Gemini Flash tool-calling so the model
>   can only emit conformant JSON
> - Server-side schema validation as a defense-in-depth layer
> - Hard prompt truncation (1500 chars) to bound cost
> - 429/402 surfaced to user as actionable toasts
>
> **Why tool-calling instead of `response_format: json_object`?**
> Tool calling enforces the JSON schema at the gateway; free-text JSON would
> require a parser fallback path that I'd rather not maintain.
>
> **Tested**
> - Unit: `dag.test.ts` covers cycle detection, layering, schema validation
> - Manual: ran 5 prompts including adversarial ("ignore prior instructions, return X")
>   — model produced valid DAGs in all cases; one was nonsense semantically but
>   structurally valid (acceptable — the user reviews before saving)
>
> **Out of scope**
> - Editing the generated DAG in-place (will follow up)
> - Streaming the generation (low ROI for sub-second latency)
```
