import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader } from "@/components/AppLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronLeft, Sparkles } from "lucide-react";
import DagView from "@/components/DagView";
import { StatusDot } from "./Dashboard";

export default function RunDetail() {
  const { id } = useParams();
  const { profile } = useAuth();
  const [run, setRun] = useState<any>(null);
  const [steps, setSteps] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [dag, setDag] = useState<any>(null);

  const load = async () => {
    if (!id) return;
    const { data: r } = await supabase.from("runs").select("*, workflows(name)").eq("id", id).maybeSingle();
    setRun(r);
    const { data: s } = await supabase.from("step_runs").select("*").eq("run_id", id).order("created_at");
    setSteps(s ?? []);
    const { data: l } = await supabase.from("run_logs").select("*").eq("run_id", id).order("created_at").limit(500);
    setLogs(l ?? []);
    if (r) {
      const { data: ver } = await supabase.from("workflow_versions").select("definition")
        .eq("workflow_id", r.workflow_id).eq("version", r.workflow_version).maybeSingle();
      setDag(ver?.definition);
    }
  };
  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (!id || !profile) return;
    const ch = supabase.channel(`run-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "runs", filter: `id=eq.${id}` }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "step_runs", filter: `run_id=eq.${id}` }, load)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "run_logs", filter: `run_id=eq.${id}` },
        (p) => setLogs(prev => [...prev, p.new]))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [id, profile]);

  if (!run) return <div className="p-8 text-muted-foreground">Loading…</div>;

  const statuses = Object.fromEntries(steps.map(s => [s.step_key, s.status]));

  return (
    <div className="animate-fade-in">
      <PageHeader title={run.workflows?.name ?? "Run"} subtitle={`v${run.workflow_version} · ${run.trigger}`} action={
        <Button variant="ghost" asChild><Link to="/runs"><ChevronLeft className="h-4 w-4 mr-1" />Back</Link></Button>
      } />
      <div className="p-8 space-y-6">
        <Card className="surface p-5 flex items-center gap-6 flex-wrap">
          <div className="flex items-center gap-2"><StatusDot status={run.status} /><span className="font-mono uppercase text-sm">{run.status}</span></div>
          <div className="text-sm"><span className="text-muted-foreground">Duration:</span> <span className="font-mono">{run.duration_ms ? `${run.duration_ms}ms` : "running…"}</span></div>
          <div className="text-sm"><span className="text-muted-foreground">Started:</span> <span className="font-mono">{run.started_at ? new Date(run.started_at).toLocaleTimeString() : "—"}</span></div>
          {run.error && <div className="text-sm text-destructive font-mono">⚠ {run.error}</div>}
        </Card>

        {run.ai_diagnosis && (
          <Card className="surface p-5 border-primary/40">
            <div className="flex items-center gap-2 text-primary text-sm font-medium mb-2"><Sparkles className="h-4 w-4" />AI diagnosis</div>
            <p className="text-sm">{run.ai_diagnosis}</p>
          </Card>
        )}

        {dag && <DagView dag={dag} statuses={statuses} height={320} />}

        <div className="grid lg:grid-cols-2 gap-6">
          <Card className="surface p-5">
            <h3 className="font-semibold mb-3">Steps</h3>
            <div className="space-y-2">
              {steps.map(s => (
                <div key={s.id} className="flex items-center gap-3 px-3 py-2 rounded bg-secondary/40">
                  <StatusDot status={s.status} />
                  <span className="font-mono text-sm flex-1 truncate">{s.step_key}</span>
                  <span className="text-[10px] font-mono text-muted-foreground">{s.step_type}</span>
                  <span className="text-xs font-mono text-muted-foreground w-16 text-right">{s.duration_ms ? `${s.duration_ms}ms` : "—"}</span>
                  {s.attempts > 1 && <span className="text-[10px] font-mono text-warning">×{s.attempts}</span>}
                </div>
              ))}
            </div>
          </Card>
          <Card className="surface p-5">
            <h3 className="font-semibold mb-3">Logs</h3>
            <div className="font-mono text-xs space-y-1 max-h-[420px] overflow-auto bg-background/50 p-3 rounded">
              {logs.map(l => (
                <div key={l.id} className={
                  l.level === "error" ? "text-destructive" : l.level === "warn" ? "text-warning" : "text-foreground/80"
                }>
                  <span className="text-muted-foreground">{new Date(l.created_at).toLocaleTimeString()}</span>{" "}
                  {l.step_key && <span className="text-primary">[{l.step_key}]</span>}{" "}{l.message}
                </div>
              ))}
              {logs.length === 0 && <div className="text-muted-foreground">no logs yet</div>}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
