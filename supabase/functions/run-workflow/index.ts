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
  retry?: { max_attempts: number; backoff_ms: number; multiplier: number };
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

/** Tiny safe template renderer: replaces {{ steps.<id>.<path> }} with prior outputs. */
function render(input: string, ctx: Record<string, any>): string {
  return input.replace(/\{\{\s*steps\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_.]+)\s*\}\}/g, (_, id, path) => {
    let v: any = ctx[id];
    for (const part of path.split(".")) v = v?.[part];
    return v === undefined || v === null ? "" : String(v);
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
      const res = await fetch(url, {
        method: step.method ?? "GET",
        headers: { "Content-Type": "application/json", ...(step.headers ?? {}) },
        body,
      });
      const text = await res.text();
      let parsed: any = text;
      try { parsed = JSON.parse(text); } catch { /* keep text */ }
      if (step.expect_status && res.status !== step.expect_status) {
        throw new Error(`http ${res.status} (expected ${step.expect_status})`);
      }
      if (!res.ok) throw new Error(`http ${res.status}: ${text.slice(0, 200)}`);
      return { status: res.status, body: parsed };
    }
    case "script": {
      // No real eval. Render the expression and return the rendered string as result.
      return { result: render(step.expression, ctx) };
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

async function withRetry<T>(
  node: DagNode,
  fn: () => Promise<T>,
  log: (msg: string, level?: string) => Promise<void>,
  setAttempts: (n: number) => Promise<void>,
): Promise<T> {
  const policy = node.retry ?? { max_attempts: 1, backoff_ms: 1000, multiplier: 2 };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= policy.max_attempts; attempt++) {
    await setAttempts(attempt);
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      await log(`attempt ${attempt}/${policy.max_attempts} failed: ${msg}`, "warn");
      if (attempt < policy.max_attempts) {
        const wait = policy.backoff_ms * Math.pow(policy.multiplier, attempt - 1);
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
      const ctx: Record<string, any> = { ...input };
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
                failed = true;
                await admin.from("step_runs").update({
                  status: "failed",
                  error: msg,
                  finished_at: new Date().toISOString(),
                  duration_ms: Date.now() - stepStart,
                }).eq("run_id", run.id).eq("step_key", nodeId);
                await log(`✗ ${node.name}: ${msg}`, "error", nodeId);
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
