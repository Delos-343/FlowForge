/**
 * FlowForge — Webhook Trigger
 * POST /webhook-trigger/:token   { input?: any }
 *
 * Public endpoint. Authenticates via the workflow's webhook_token, then
 * enqueues a run by invoking run-workflow with a service-role JWT minted
 * for the workflow's creator. Returns { run_id }.
 */
// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    // path: /webhook-trigger/<token>
    const parts = url.pathname.split("/").filter(Boolean);
    const token = parts[parts.length - 1];
    if (!token || token === "webhook-trigger") {
      return json({ error: "missing token" }, 400);
    }

    let input: any = {};
    if (req.method !== "GET") {
      try { input = (await req.json())?.input ?? {}; } catch { /* allow empty */ }
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: wf, error: wfErr } = await admin
      .from("workflows")
      .select("id, tenant_id, current_version, name, is_active, created_by")
      .eq("webhook_token", token)
      .maybeSingle();
    if (wfErr || !wf) return json({ error: "invalid webhook token" }, 404);
    if (!wf.is_active) return json({ error: "workflow disabled" }, 409);

    // Create run row directly (avoid re-auth path)
    const { data: run, error: runErr } = await admin
      .from("runs")
      .insert({
        tenant_id: wf.tenant_id,
        workflow_id: wf.id,
        workflow_version: wf.current_version,
        status: "queued",
        trigger: "webhook",
        triggered_by: wf.created_by,
        started_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (runErr || !run) return json({ error: runErr?.message ?? "failed" }, 500);

    // Ask run-workflow to execute by id (with a service-internal flag).
    // Simpler: kick the executor inline by calling its function URL with a special header.
    fetch(`${SUPABASE_URL}/functions/v1/run-workflow`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-service-role": SERVICE_ROLE,
      },
      body: JSON.stringify({
        workflow_id: wf.id,
        run_id: run.id,
        trigger: "webhook",
        input,
        _internal: true,
      }),
    }).catch((e) => console.error("dispatch failed:", e));

    return json({ run_id: run.id, status: "queued" }, 202);
  } catch (e) {
    console.error("webhook-trigger:", e);
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
