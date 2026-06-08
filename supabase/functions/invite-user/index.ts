// @ts-nocheck
/**
 * invite-user — admin invites a teammate by email.
 * Creates an invitations row and returns the accept URL.
 * (No email-sending infra is configured; the URL is shown in the UI for the admin to share.)
 *
 * POST { email, role }     -> { invite_id, accept_url, token }
 * GET  ?token=...          -> { tenant_name, email, role } (public lookup for accept page)
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const url = new URL(req.url);

  if (req.method === "GET") {
    const token = url.searchParams.get("token");
    if (!token) return json({ error: "token required" }, 400);
    const { data } = await admin.from("invitations")
      .select("email, role, status, expires_at, tenant_id, tenants(name)")
      .eq("token", token).maybeSingle();
    if (!data) return json({ error: "not_found" }, 404);
    if (data.status !== "pending" || new Date(data.expires_at) < new Date())
      return json({ error: "expired_or_used" }, 410);
    return json({ email: data.email, role: data.role, tenant_name: (data as any).tenants?.name });
  }

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "missing authorization" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "invalid token" }, 401);

  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const role = ["admin", "editor", "viewer"].includes(body.role) ? body.role : "editor";
  if (!email || !email.includes("@")) return json({ error: "invalid email" }, 400);

  const { data: profile } = await admin.from("profiles").select("tenant_id").eq("id", user.id).maybeSingle();
  if (!profile) return json({ error: "no_tenant" }, 400);

  const { data: isAdmin } = await admin.rpc("has_role", {
    _user_id: user.id, _tenant: profile.tenant_id, _role: "admin",
  });
  if (!isAdmin) return json({ error: "forbidden" }, 403);

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const { data: inv, error } = await admin.from("invitations").insert({
    tenant_id: profile.tenant_id,
    email,
    role,
    token,
    invited_by: user.id,
  }).select().single();
  if (error) return json({ error: error.message }, 500);

  const origin = req.headers.get("origin") ?? "";
  return json({
    invite_id: inv.id,
    token,
    accept_url: `${origin}/accept-invite?token=${token}`,
  });
});
