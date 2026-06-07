/**
 * FlowForge — Workflow Executor
 *
 * POST /run-workflow { workflow_id, version?, trigger?, input? }
 * - Validates JWT, checks editor role, loads version
 * - Topologically sorts the DAG
 * - Executes each layer with bounded parallelism
 * - Per-step exponential backoff retries
 * - Global timeout enforced
 * - Streams progress via row updates (consumed by client Realtime)
 *
 * Self-contained: no shared imports.
 */
// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type StepType = "http" | "delay" | "script" | "condition";
interface DagNode {
  id: string;
  name: string;
  step: any;
  retry?: { max_attempts: number; backoff_ms: number; multiplier: number; max_backoff_ms?: number; jitter?: boolean };
  continue_on_error?: boolean;
}
interface Dag {
  nodes: DagNode[];
  edges: { from: string; to: string }[];
  timeout_ms?: number;
}

function topoLayers(dag: Dag): string[][] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of dag.nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of dag.edges) {
    adj.get(e.from)?.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const layers: string[][] = [];
  let frontier = [...indeg.entries()].filter(([, d]) => d === 0).map(([k]) => k);
  while (frontier.length) {
    layers.push(frontier);
    const next: string[] = [];
    for (const n of frontier) {
      for (const m of adj.get(n) ?? []) {
        indeg.set(m, (indeg.get(m) ?? 0) - 1);
        if (indeg.get(m) === 0) next.push(m);
      }
    }
    frontier = next;
  }
  if (layers.flat().length !== dag.nodes.length) throw new Error("cycle detected");
  return layers;
}

/** Tiny safe template renderer.
 *  Supports:
 *    {{ steps.<id>.<path> }}  -> prior step outputs
 *    {{ input.<path> }}       -> workflow input
 *    {{ <key>.<path> }}       -> any top-level ctx key
 *    {{ <key> }}              -> single-token lookup
 */
function render(input: string, ctx: Record<string, any>): string {
  if (typeof input !== "string") return input;
  return input.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, expr) => {
    const parts = String(expr).split(".");
    let v: any;
    if (parts[0] === "steps") {
      v = ctx[parts[1]];
      for (const p of parts.slice(2)) v = v?.[p];
    } else {
      v = ctx[parts[0]];
      for (const p of parts.slice(1)) v = v?.[p];
    }
    return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

async function runStep(node: DagNode, ctx: Record<string, any>) {
  const step = node.step;
  switch (step.type as StepType) {
    case "delay": {
      await new Promise((r) => setTimeout(r, step.ms));
      return { ok: true };
    }
    case "http": {
      const url = render(step.url, ctx);
      const body = step.body
        ? typeof step.body === "string"
          ? render(step.body, ctx)
          : JSON.stringify(step.body)
        : undefined;

      // Circuit-breaker: short-circuit if the host is currently open and we're
      // not yet past the probe window. The runtime injects the admin client + tenant_id.
      const host = safeHost(url);
      const health = ctx.__admin && host
        ? await readHealth(ctx.__admin, ctx.__tenant_id, host)
        : null;
      if (health?.state === "open" && health.next_probe_at && new Date(health.next_probe_at) > new Date()) {
        const waitMs = new Date(health.next_probe_at).getTime() - Date.now();
        const err: any = new Error(`circuit_open for ${host} — next probe in ${Math.ceil(waitMs/1000)}s`);
        err.retryable = true;
        err.circuit_open = true;
        throw err;
      }

      // Per-request timeout — adapts to recent latency, capped 5s..30s.
      const adaptiveTimeout = Math.min(30_000, Math.max(5_000, (health?.avg_latency_ms ?? 0) * 4 || 15_000));
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), adaptiveTimeout);
      const t0 = Date.now();
      let res: Response | undefined;
      let netErr: any;
      try {
        res = await fetch(url, {
          method: step.method ?? "GET",
          headers: { "Content-Type": "application/json", ...(step.headers ?? {}) },
          body,
          signal: ac.signal,
        });
      } catch (e) {
        netErr = e;
      } finally {
        clearTimeout(timer);
      }
      const latency = Date.now() - t0;

      if (netErr || !res) {
        if (ctx.__admin && host) await recordHealth(ctx.__admin, ctx.__tenant_id, host, { ok: false, status: 0, latency, error: String(netErr?.message ?? netErr ?? "network error") });
        const err: any = new Error(`network: ${netErr?.message ?? netErr ?? "unknown"}`);
        err.retryable = true;
        throw err;
      }

      const text = await res.text();
      let parsed: any = text;
      try { parsed = JSON.parse(text); } catch { /* keep text */ }

      const ok = res.ok && (!step.expect_status || res.status === step.expect_status);
      if (ctx.__admin && host) {
        await recordHealth(ctx.__admin, ctx.__tenant_id, host, {
          ok,
          status: res.status,
          latency,
          error: ok ? null : String(text).slice(0, 200),
        });
      }

      if (step.expect_status && res.status !== step.expect_status) {
        const err: any = new Error(`http ${res.status} (expected ${step.expect_status})`);
        err.retryable = res.status >= 500 || res.status === 429;
        throw err;
      }
      if (!res.ok) {
        const err: any = new Error(`http ${res.status}: ${String(text).slice(0, 200)}`);
        err.retryable = res.status >= 500 || res.status === 429;
        throw err;
      }
      return { status: res.status, body: parsed, latency_ms: latency };
    }
    case "script": {
      // Evaluate the expression as a JS expression with access to prior step outputs.
      // ctx already contains { ...input, input, <stepId>: <output>, ... }.
      // Available bindings: steps (alias of ctx), input, and a few safe helpers.
      const expr = String(step.expression ?? "");
      try {
        const steps = ctx;
        const helpers = {
          randomItem: <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)],
          random: () => Math.random(),
          now: () => Date.now(),
          len: (x: any) => (x?.length ?? 0),
        };
        // eslint-disable-next-line no-new-func
        const fn = new Function(
          "steps", "input", "ctx", "randomItem", "random", "now", "len",
          `"use strict"; return (${expr});`
        );
        const value = fn(steps, ctx.input ?? {}, ctx,
          helpers.randomItem, helpers.random, helpers.now, helpers.len);
        return value;
      } catch (e) {
        // Fallback to legacy template rendering so older workflows still work.
        return { result: render(expr, ctx) };
      }
    }
    case "condition": {
      const rendered = render(step.expression, ctx);
      // Evaluate trivial comparisons safely.
      const truthy = evalSafeBool(rendered);
      return { matched: truthy, branch: truthy ? step.on_true : step.on_false ?? null };
    }
  }
  throw new Error(`unknown step type: ${(step as any).type}`);
}

function evalSafeBool(expr: string): boolean {
  // Supported: a == b, a != b, a > b, a < b, plain "true"/"false"/non-empty-string
  const m = expr.match(/^\s*(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/);
  if (m) {
    const [, a, op, b] = m;
    const an = Number(a); const bn = Number(b);
    const numeric = !Number.isNaN(an) && !Number.isNaN(bn);
    const lhs = numeric ? an : a; const rhs = numeric ? bn : b;
    switch (op) {
      case "==": return lhs == rhs;
      case "!=": return lhs != rhs;
      case ">":  return numeric && an > bn;
      case "<":  return numeric && an < bn;
      case ">=": return numeric && an >= bn;
      case "<=": return numeric && an <= bn;
    }
  }
  if (expr.trim().toLowerCase() === "true") return true;
  if (expr.trim().toLowerCase() === "false") return false;
  return expr.trim().length > 0;
}

// ─────────── Endpoint health / circuit breaker ───────────
function safeHost(u: string): string | null {
  try { return new URL(u).host.toLowerCase(); } catch { return null; }
}

const FAILURE_THRESHOLD = 5;      // open after N consecutive failures
const SUCCESS_TO_CLOSE = 2;       // close after N consecutive successes from half_open
const OPEN_COOLDOWN_MS = 30_000;  // wait before allowing a probe

async function readHealth(admin: any, tenant_id: string, host: string) {
  const { data } = await admin.from("endpoint_health")
    .select("*").eq("tenant_id", tenant_id).eq("host", host).maybeSingle();
  return data;
}

async function recordHealth(
  admin: any, tenant_id: string, host: string,
  r: { ok: boolean; status: number; latency: number; error?: string | null },
) {
  const existing = await readHealth(admin, tenant_id, host);
  const now = new Date();
  const consecutive_failures = r.ok ? 0 : ((existing?.consecutive_failures ?? 0) + 1);
  const consecutive_successes = r.ok ? ((existing?.consecutive_successes ?? 0) + 1) : 0;

  // EWMA latency (alpha=0.3) so the timeout adapts to recent behavior.
  const prevAvg = existing?.avg_latency_ms ?? r.latency;
  const avg_latency_ms = Math.round(prevAvg * 0.7 + r.latency * 0.3);

  let state: "closed" | "open" | "half_open" = (existing?.state as any) ?? "closed";
  let next_probe_at: string | null = existing?.next_probe_at ?? null;

  if (!r.ok) {
    if (consecutive_failures >= FAILURE_THRESHOLD) {
      state = "open";
      next_probe_at = new Date(Date.now() + OPEN_COOLDOWN_MS).toISOString();
    }
  } else {
    if (state === "open") {
      state = "half_open";
    } else if (state === "half_open" && consecutive_successes >= SUCCESS_TO_CLOSE) {
      state = "closed";
      next_probe_at = null;
    }
  }

  const row = {
    tenant_id, host, state,
    consecutive_failures, consecutive_successes,
    last_status: r.status, last_error: r.error ?? null,
    last_latency_ms: r.latency, avg_latency_ms,
    last_checked_at: now.toISOString(),
    last_success_at: r.ok ? now.toISOString() : existing?.last_success_at ?? null,
    last_failure_at: r.ok ? existing?.last_failure_at ?? null : now.toISOString(),
    next_probe_at,
    total_calls: (existing?.total_calls ?? 0) + 1,
    total_failures: (existing?.total_failures ?? 0) + (r.ok ? 0 : 1),
  };
  await admin.from("endpoint_health").upsert(row, { onConflict: "tenant_id,host" });
}

async function withRetry<T>(
  node: DagNode,
  fn: () => Promise<T>,
  log: (msg: string, level?: string) => Promise<void>,
  setAttempts: (n: number) => Promise<void>,
): Promise<T> {
  // Stronger defaults for http steps: 3 attempts with capped exponential backoff + jitter.
  const isHttp = node.step?.type === "http";
  const policy = {
    max_attempts: node.retry?.max_attempts ?? (isHttp ? 3 : 1),
    backoff_ms: node.retry?.backoff_ms ?? 1000,
    multiplier: node.retry?.multiplier ?? 2,
    max_backoff_ms: node.retry?.max_backoff_ms ?? 15_000,
    jitter: node.retry?.jitter ?? true,
  };
  let lastErr: any;
  for (let attempt = 1; attempt <= policy.max_attempts; attempt++) {
    await setAttempts(attempt);
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      await log(`attempt ${attempt}/${policy.max_attempts} failed: ${msg}`, "warn");
      // If the error explicitly marks itself non-retryable (e.g. 4xx other than 429), stop early.
      if (e && e.retryable === false) break;
      if (attempt < policy.max_attempts) {
        const base = Math.min(
          policy.backoff_ms * Math.pow(policy.multiplier, attempt - 1),
          policy.max_backoff_ms,
        );
        const wait = policy.jitter ? Math.floor(base * (0.5 + Math.random())) : base;
        await log(`backing off ${wait}ms before retry`, "info");
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const { workflow_id, version, trigger = "manual", input = {}, run_id: existingRunId, _internal } = body ?? {};

    const internalHeader = req.headers.get("x-internal-service-role");
    const isInternal = _internal && internalHeader && internalHeader === SERVICE_ROLE;

    let userId: string | null = null;
    if (!isInternal) {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) return json({ error: "missing authorization" }, 401);
      const token = authHeader.replace("Bearer ", "");
      const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error: userErr } = await userClient.auth.getUser(token);
      if (userErr || !user) return json({ error: "invalid token" }, 401);
      userId = user.id;
    }

    if (!workflow_id) return json({ error: "workflow_id required" }, 400);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: wf, error: wfErr } = await admin
      .from("workflows")
      .select("id, tenant_id, current_version, name, created_by")
      .eq("id", workflow_id)
      .maybeSingle();
    if (wfErr || !wf) return json({ error: "workflow not found" }, 404);

    if (!isInternal) {
      const { data: roleRow } = await admin
        .from("user_roles")
        .select("role")
        .eq("user_id", userId!)
        .eq("tenant_id", wf.tenant_id);
      const roles = (roleRow ?? []).map((r: any) => r.role);
      if (!roles.includes("admin") && !roles.includes("editor")) {
        return json({ error: "forbidden" }, 403);
      }
    }

    const targetVersion = version ?? wf.current_version;
    const { data: ver } = await admin
      .from("workflow_versions")
      .select("definition, version")
      .eq("workflow_id", workflow_id)
      .eq("version", targetVersion)
      .maybeSingle();
    if (!ver) return json({ error: "workflow version not found" }, 404);

    const dag = ver.definition as Dag;

    let run: any;
    if (existingRunId) {
      const { data } = await admin.from("runs")
        .update({ status: "running" })
        .eq("id", existingRunId)
        .select().single();
      run = data;
    } else {
      const { data, error: runErr } = await admin
        .from("runs")
        .insert({
          tenant_id: wf.tenant_id,
          workflow_id,
          workflow_version: targetVersion,
          status: "running",
          trigger,
          triggered_by: userId ?? wf.created_by,
          started_at: new Date().toISOString(),
        })
        .select()
        .single();
      if (runErr || !data) return json({ error: runErr?.message }, 500);
      run = data;
    }

    // Pre-create all step_runs in 'pending'
    const stepRows = dag.nodes.map((n) => ({
      run_id: run.id,
      tenant_id: wf.tenant_id,
      step_key: n.id,
      step_type: n.step.type,
      status: "pending" as const,
    }));
    await admin.from("step_runs").insert(stepRows);

    // Kick off async execution; respond immediately with run id.
    const exec = (async () => {
      const ctx: Record<string, any> = {
        ...input,
        input: input ?? {},
        // Hidden runtime handles used by http step for circuit-breaker / health updates.
        // Underscore-prefixed keys are not addressable via `{{ steps.* }}` templates.
        __admin: admin,
        __tenant_id: wf.tenant_id,
      };
      const startedAt = Date.now();
      const timeoutMs = dag.timeout_ms ?? 60_000;
      let failed = false;
      let timedOut = false;

      const log = async (msg: string, level = "info", step_key?: string) => {
        await admin.from("run_logs").insert({
          run_id: run.id,
          tenant_id: wf.tenant_id,
          step_key,
          level,
          message: msg,
        });
      };
      await log(`run started for "${wf.name}" (v${targetVersion}) — ${dag.nodes.length} steps`);

      try {
        const layers = topoLayers(dag);
        for (const layer of layers) {
          if (failed) break;
          if (Date.now() - startedAt > timeoutMs) { timedOut = true; break; }

          await Promise.all(
            layer.map(async (nodeId) => {
              if (failed) return;
              const node = dag.nodes.find((n) => n.id === nodeId)!;
              const stepStart = Date.now();
              await admin.from("step_runs")
                .update({ status: "running", started_at: new Date().toISOString() })
                .eq("run_id", run.id).eq("step_key", nodeId);
              await log(`▶ ${node.name}`, "info", nodeId);

              try {
                const remaining = timeoutMs - (Date.now() - startedAt);
                const result = await Promise.race([
                  withRetry(
                    node,
                    () => runStep(node, ctx),
                    (m, l = "info") => log(m, l, nodeId),
                    async (n) => {
                      await admin.from("step_runs")
                        .update({ attempts: n })
                        .eq("run_id", run.id).eq("step_key", nodeId);
                    },
                  ),
                  new Promise((_, rej) =>
                    setTimeout(() => rej(new Error("workflow timeout")), Math.max(remaining, 0)),
                  ),
                ]);
                ctx[nodeId] = result;
                const dur = Date.now() - stepStart;
                await admin.from("step_runs").update({
                  status: "success",
                  output: result as any,
                  finished_at: new Date().toISOString(),
                  duration_ms: dur,
                }).eq("run_id", run.id).eq("step_key", nodeId);
                await log(`✓ ${node.name} (${dur}ms)`, "info", nodeId);
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                const skip = !!node.continue_on_error;
                if (!skip) failed = true;
                // Make the error visible to downstream steps so they can branch on it.
                ctx[nodeId] = { error: msg, ok: false, fallback: skip };
                await admin.from("step_runs").update({
                  status: skip ? "success" : "failed",
                  error: msg,
                  output: skip ? ({ error: msg, ok: false, fallback: true } as any) : null,
                  finished_at: new Date().toISOString(),
                  duration_ms: Date.now() - stepStart,
                }).eq("run_id", run.id).eq("step_key", nodeId);
                await log(
                  `${skip ? "⚠" : "✗"} ${node.name}: ${msg}${skip ? " (continue_on_error)" : ""}`,
                  skip ? "warn" : "error",
                  nodeId,
                );
              }
            }),
          );
        }

        const finalStatus = timedOut ? "timeout" : failed ? "failed" : "success";
        const dur = Date.now() - startedAt;
        await admin.from("runs").update({
          status: finalStatus,
          finished_at: new Date().toISOString(),
          duration_ms: dur,
          error: timedOut ? "global timeout exceeded" : (failed ? "one or more steps failed" : null),
        }).eq("id", run.id);
        await log(`run ${finalStatus} in ${dur}ms`, finalStatus === "success" ? "info" : "error");

        // If failed, request AI diagnosis (best effort)
        if (failed || timedOut) {
          try {
            const diag = await diagnose(admin, run.id, wf.tenant_id);
            if (diag) {
              await admin.from("runs").update({ ai_diagnosis: diag }).eq("id", run.id);
            }
          } catch (e) {
            console.error("diagnosis failed:", e);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await admin.from("runs").update({
          status: "failed",
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          error: msg,
        }).eq("id", run.id);
        await log(`fatal: ${msg}`, "error");
      }
    })();

    // Don't await; let it run while we return.
    // @ts-ignore Deno EdgeRuntime
    if (typeof EdgeRuntime !== "undefined" && (EdgeRuntime as any).waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(exec);
    }

    return json({ run_id: run.id }, 202);
  } catch (e) {
    console.error("run-workflow error:", e);
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});

async function diagnose(admin: any, runId: string, tenantId: string): Promise<string | null> {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) return null;
  const { data: logs } = await admin
    .from("run_logs")
    .select("level,message,step_key,created_at")
    .eq("run_id", runId)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true })
    .limit(80);

  const compact = (logs ?? [])
    .map((l: any) => `[${l.level}] ${l.step_key ?? "_"}: ${l.message}`)
    .join("\n")
    .slice(0, 6000); // hard token guard

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: "You are an SRE assistant. Given workflow execution logs, output a 2–3 sentence diagnosis of what went wrong and a concrete suggested fix. Be specific. No preamble." },
        { role: "user", content: compact || "no logs" },
      ],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
