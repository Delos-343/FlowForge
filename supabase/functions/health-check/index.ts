/**
 * FlowForge — Endpoint Health Probe
 *
 * POST /health-check { hosts?: string[], url?: string }
 *   - If `url` is provided: probe it directly (GET) and update endpoint_health.
 *   - If `hosts` is provided: probe each host via "https://<host>/" (HEAD then GET fallback).
 *   - If neither: re-probe all "open" or "half_open" endpoints for the caller's tenant.
 *
 * Returns: { results: [{ host, ok, status, latency_ms, state }] }
 */
// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const FAILURE_THRESHOLD = 5;
const SUCCESS_TO_CLOSE = 2;
const OPEN_COOLDOWN_MS = 30_000;
const PROBE_TIMEOUT_MS = 8_000;

function safeHost(u: string): string | null {
  try { return new URL(u).host.toLowerCase(); } catch { return null; }
}

async function probe(url: string): Promise<{ ok: boolean; status: number; latency: number; error?: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    // Prefer HEAD; if not allowed, fall back to GET.
    let res = await fetch(url, { method: "HEAD", signal: ac.signal, redirect: "follow" });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: "GET", signal: ac.signal, redirect: "follow" });
      await res.body?.cancel();
    }
    return { ok: res.ok || res.status < 500, status: res.status, latency: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, status: 0, latency: Date.now() - t0, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function upsertHealth(
  admin: any, tenant_id: string, host: string,
  r: { ok: boolean; status: number; latency: number; error?: string | null },
) {
  const { data: existing } = await admin.from("endpoint_health")
    .select("*").eq("tenant_id", tenant_id).eq("host", host).maybeSingle();
  const now = new Date();
  const consecutive_failures = r.ok ? 0 : ((existing?.consecutive_failures ?? 0) + 1);
  const consecutive_successes = r.ok ? ((existing?.consecutive_successes ?? 0) + 1) : 0;
  const prevAvg = existing?.avg_latency_ms ?? r.latency;
  const avg_latency_ms = Math.round(prevAvg * 0.7 + r.latency * 0.3);

  let state: "closed" | "open" | "half_open" = (existing?.state as any) ?? "closed";
  let next_probe_at: string | null = existing?.next_probe_at ?? null;
  if (!r.ok && consecutive_failures >= FAILURE_THRESHOLD) {
    state = "open";
    next_probe_at = new Date(Date.now() + OPEN_COOLDOWN_MS).toISOString();
  } else if (r.ok) {
    if (state === "open") state = "half_open";
    else if (state === "half_open" && consecutive_successes >= SUCCESS_TO_CLOSE) {
      state = "closed";
      next_probe_at = null;
    }
  }

  await admin.from("endpoint_health").upsert({
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
  }, { onConflict: "tenant_id,host" });

  return { state };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "missing authorization" }, 401);

    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: uerr } = await userClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (uerr || !user) return json({ error: "invalid token" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: profile } = await admin.from("profiles").select("tenant_id").eq("id", user.id).maybeSingle();
    if (!profile?.tenant_id) return json({ error: "no tenant" }, 403);
    const tenant_id = profile.tenant_id;

    let body: any = {};
    try { body = await req.json(); } catch { /* allow empty */ }

    let targets: { host: string; url: string }[] = [];
    if (body.url && typeof body.url === "string") {
      const host = safeHost(body.url);
      if (!host) return json({ error: "invalid url" }, 400);
      targets = [{ host, url: body.url }];
    } else if (Array.isArray(body.hosts) && body.hosts.length) {
      targets = body.hosts.slice(0, 25).map((h: string) => ({
        host: h.toLowerCase(),
        url: `https://${h.replace(/^https?:\/\//, "").replace(/\/$/, "")}/`,
      }));
    } else {
      const { data: rows } = await admin.from("endpoint_health")
        .select("host").eq("tenant_id", tenant_id)
        .in("state", ["open", "half_open"]).limit(25);
      targets = (rows ?? []).map((r: any) => ({ host: r.host, url: `https://${r.host}/` }));
    }

    if (targets.length === 0) return json({ results: [] });

    const results = await Promise.all(targets.map(async ({ host, url }) => {
      const r = await probe(url);
      const { state } = await upsertHealth(admin, tenant_id, host, r);
      return { host, ok: r.ok, status: r.status, latency_ms: r.latency, state, error: r.error ?? null };
    }));

    return json({ results });
  } catch (e) {
    console.error("health-check:", e);
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
