// @ts-nocheck
/**
 * cron-dispatch — invoked by pg_cron every minute.
 * Finds active workflows whose cron schedule is due, kicks off run-workflow,
 * and stamps next_run_at for the next cycle.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { Cron } from "https://esm.sh/croner@8.1.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

function nextFire(expr: string): Date | null {
  try {
    const c = new Cron(expr, { timezone: "UTC" });
    const n = c.nextRun();
    return n ?? null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const now = new Date();

  // Pull active scheduled workflows whose next_run_at is null or due
  const { data: due, error } = await admin
    .from("workflows")
    .select("id, tenant_id, cron_expression, next_run_at, current_version")
    .eq("is_active", true)
    .not("cron_expression", "is", null)
    .or(`next_run_at.is.null,next_run_at.lte.${now.toISOString()}`)
    .limit(100);

  if (error) {
    return Response.json({ error: error.message }, { status: 500, headers: cors });
  }

  const results: any[] = [];
  for (const wf of due ?? []) {
    const next = nextFire(wf.cron_expression!);
    if (!next) {
      results.push({ id: wf.id, skipped: "invalid_cron" });
      continue;
    }

    // First time we see this schedule — just stamp next_run_at, don't fire.
    if (!wf.next_run_at) {
      await admin.from("workflows")
        .update({ next_run_at: next.toISOString() })
        .eq("id", wf.id);
      results.push({ id: wf.id, scheduled: next.toISOString() });
      continue;
    }

    // Fire the run, then advance the schedule.
    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/run-workflow`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-service-role": SERVICE_ROLE,
        },
        body: JSON.stringify({
          workflow_id: wf.id,
          trigger: "schedule",
          _internal: true,
        }),
      });
      const j = await r.json().catch(() => ({}));
      await admin.from("workflows").update({
        next_run_at: next.toISOString(),
        last_scheduled_at: now.toISOString(),
      }).eq("id", wf.id);
      results.push({ id: wf.id, run_id: j.run_id ?? null, status: r.status });
    } catch (e) {
      results.push({ id: wf.id, error: String((e as Error).message) });
    }
  }

  return Response.json({ checked: due?.length ?? 0, results }, { headers: cors });
});
