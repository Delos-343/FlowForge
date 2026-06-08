// @ts-nocheck
/**
 * explain-dag — given a workflow DAG, return a plain-English explanation.
 * POST { workflow_id } -> { explanation }
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "missing authorization" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "invalid token" }, 401);

  const { workflow_id } = await req.json().catch(() => ({}));
  if (!workflow_id) return json({ error: "workflow_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: wf } = await admin.from("workflows")
    .select("id, name, description, current_version, tenant_id")
    .eq("id", workflow_id).maybeSingle();
  if (!wf) return json({ error: "not_found" }, 404);

  // Tenant access check
  const { data: prof } = await admin.from("profiles").select("tenant_id").eq("id", user.id).maybeSingle();
  if (prof?.tenant_id !== wf.tenant_id) return json({ error: "forbidden" }, 403);

  const { data: ver } = await admin.from("workflow_versions")
    .select("definition").eq("workflow_id", workflow_id).eq("version", wf.current_version).maybeSingle();
  if (!ver) return json({ error: "no_version" }, 404);

  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) return json({ error: "ai_unconfigured" }, 500);

  const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: "Explain workflow DAGs to non-engineers. 3-5 short sentences. No preamble. Focus on what it does end-to-end, key branches, and failure handling." },
        { role: "user", content: `Workflow: ${wf.name}\nDescription: ${wf.description ?? "(none)"}\nDAG JSON:\n${JSON.stringify(ver.definition).slice(0, 5000)}` },
      ],
    }),
  });
  if (!r.ok) return json({ error: `ai ${r.status}` }, 500);
  const j = await r.json();
  return json({ explanation: j?.choices?.[0]?.message?.content ?? "" });
});
