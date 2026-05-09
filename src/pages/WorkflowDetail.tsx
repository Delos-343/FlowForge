import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import DagView from "@/components/DagView";
import { Play, Save, RotateCcw, ChevronLeft, Webhook, Copy, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { DagSchema } from "@/lib/dag";

export default function WorkflowDetail() {
  const { id } = useParams();
  const { profile, canEdit } = useAuth();
  const nav = useNavigate();
  const [wf, setWf] = useState<any>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [activeVer, setActiveVer] = useState<any>(null);
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!id) return;
    const { data: w } = await supabase.from("workflows").select("*").eq("id", id).maybeSingle();
    setWf(w);
    const { data: vs } = await supabase.from("workflow_versions").select("*").eq("workflow_id", id).order("version", { ascending: false });
    setVersions(vs ?? []);
    const cur = (vs ?? []).find(v => v.version === w?.current_version) ?? vs?.[0];
    setActiveVer(cur);
    setJson(JSON.stringify(cur?.definition ?? {}, null, 2));
  };
  useEffect(() => { load(); }, [id]);

  const validateJson = (text: string) => {
    try {
      const parsed = JSON.parse(text);
      DagSchema.parse(parsed);
      setError(null);
      return parsed;
    } catch (e: any) {
      setError(e.message ?? "invalid");
      return null;
    }
  };

  const save = async () => {
    const dag = validateJson(json);
    if (!dag || !profile || !wf) return;
    const nextVer = (versions[0]?.version ?? 0) + 1;
    const { error: ve } = await supabase.from("workflow_versions").insert({
      workflow_id: wf.id, version: nextVer, definition: dag, created_by: profile.id,
    });
    if (ve) return toast.error(ve.message);
    await supabase.from("workflows").update({ current_version: nextVer }).eq("id", wf.id);
    toast.success(`Saved as v${nextVer}`);
    load();
  };

  const rollback = async (v: any) => {
    if (!wf) return;
    await supabase.from("workflows").update({ current_version: v.version }).eq("id", wf.id);
    toast.success(`Rolled back to v${v.version}`);
    load();
  };

  const run = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/run-workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ workflow_id: wf.id }),
    });
    const j = await r.json();
    if (!r.ok) return toast.error(j.error);
    nav(`/runs/${j.run_id}`);
  };

  const generateWebhook = async () => {
    if (!wf) return;
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const { error } = await supabase.from("workflows").update({ webhook_token: token }).eq("id", wf.id);
    if (error) return toast.error(error.message);
    toast.success("Webhook URL generated");
    load();
  };

  const revokeWebhook = async () => {
    if (!wf) return;
    const { error } = await supabase.from("workflows").update({ webhook_token: null }).eq("id", wf.id);
    if (error) return toast.error(error.message);
    toast.success("Webhook revoked");
    load();
  };

  const webhookUrl = wf?.webhook_token
    ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/webhook-trigger/${wf.webhook_token}`
    : null;

  const copyWebhook = () => {
    if (!webhookUrl) return;
    navigator.clipboard.writeText(webhookUrl);
    toast.success("Copied");
  };

  if (!wf || !activeVer) return <div className="p-4 sm:p-6 md:p-8 text-muted-foreground">Loading…</div>;

  let preview: any = null;
  try { preview = JSON.parse(json); } catch { /* */ }

  return (
    <div className="animate-fade-in">
      <PageHeader title={wf.name} subtitle={`Active: v${wf.current_version}`} action={
        <div className="flex gap-2">
          <Button variant="ghost" asChild><Link to="/workflows"><ChevronLeft className="h-4 w-4 mr-1" />Back</Link></Button>
          {canEdit && <Button variant="outline" onClick={save} disabled={!!error}><Save className="h-4 w-4 mr-2" />Save new version</Button>}
          {canEdit && <Button onClick={run} className="bg-gradient-primary text-primary-foreground"><Play className="h-4 w-4 mr-2" />Run now</Button>}
        </div>
      } />
      <div className="p-4 sm:p-6 md:p-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="surface p-4 lg:col-span-2">
          <div className="text-xs font-mono text-muted-foreground mb-2">DAG PREVIEW</div>
          {preview?.nodes ? <DagView dag={preview} height={420} /> : <div className="h-[420px] grid place-items-center text-muted-foreground">Invalid DAG</div>}
        </Card>
        <div className="space-y-4">
          <Card className="surface p-4">
            <div className="text-xs font-mono text-muted-foreground mb-2">DEFINITION (JSON)</div>
            <Textarea value={json} onChange={e => { setJson(e.target.value); validateJson(e.target.value); }}
              className="font-mono text-xs h-72" spellCheck={false} disabled={!canEdit} />
            {error && <div className="text-xs text-destructive mt-2 font-mono">{error}</div>}
          </Card>
          <Card className="surface p-4">
            <div className="text-xs font-mono text-muted-foreground mb-2">VERSION HISTORY</div>
            <div className="space-y-1 max-h-72 overflow-auto">
              {versions.map(v => (
                <div key={v.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-secondary/50">
                  <span className="font-mono text-xs flex-1">v{v.version}</span>
                  {v.version === wf.current_version && <span className="text-[10px] font-mono text-success">ACTIVE</span>}
                  <span className="text-xs text-muted-foreground">{new Date(v.created_at).toLocaleDateString()}</span>
                  {canEdit && v.version !== wf.current_version && (
                    <Button size="sm" variant="ghost" onClick={() => rollback(v)}><RotateCcw className="h-3 w-3" /></Button>
                  )}
                </div>
              ))}
            </div>
          </Card>
          <Card className="surface p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-mono text-muted-foreground flex items-center gap-2"><Webhook className="h-3 w-3" />WEBHOOK TRIGGER</div>
              {canEdit && (
                webhookUrl
                  ? <Button size="sm" variant="ghost" onClick={revokeWebhook} className="text-destructive h-7">Revoke</Button>
                  : <Button size="sm" variant="ghost" onClick={generateWebhook} className="h-7"><RefreshCw className="h-3 w-3 mr-1" />Generate</Button>
              )}
            </div>
            {webhookUrl ? (
              <div className="space-y-2">
                <div className="flex gap-1">
                  <code className="flex-1 text-[10px] font-mono bg-secondary/50 p-2 rounded break-all">{webhookUrl}</code>
                  <Button size="sm" variant="outline" onClick={copyWebhook}><Copy className="h-3 w-3" /></Button>
                </div>
                <p className="text-[10px] text-muted-foreground font-mono">POST with optional {'{ "input": {...} }'} body</p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No webhook configured. Generate a token to expose a public trigger URL.</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
