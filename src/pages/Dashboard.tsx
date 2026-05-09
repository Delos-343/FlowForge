import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader } from "@/components/AppLayout";
import { Card } from "@/components/ui/card";
import { Activity, CheckCircle2, XCircle, Clock } from "lucide-react";
import { Link } from "react-router-dom";

export default function Dashboard() {
  const { profile } = useAuth();
  const [stats, setStats] = useState({ active: 0, success: 0, failed: 0, avgMs: 0, total: 0 });
  const [recent, setRecent] = useState<any[]>([]);

  useEffect(() => {
    if (!profile) return;
    const load = async () => {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data: runs } = await supabase.from("runs")
        .select("id, status, duration_ms, created_at, workflows(name)")
        .eq("tenant_id", profile.tenant_id)
        .gte("created_at", since)
        .order("created_at", { ascending: false });
      const r = runs ?? [];
      const success = r.filter(x => x.status === "success");
      const failed = r.filter(x => ["failed", "timeout"].includes(x.status));
      const active = r.filter(x => ["pending", "running"].includes(x.status));
      const durations = success.map(x => x.duration_ms ?? 0).filter(Boolean);
      setStats({
        active: active.length, success: success.length, failed: failed.length, total: r.length,
        avgMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      });
      setRecent(r.slice(0, 8));
    };
    load();
    const ch = supabase.channel("dash-runs")
      .on("postgres_changes", { event: "*", schema: "public", table: "runs", filter: `tenant_id=eq.${profile.tenant_id}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [profile]);

  const successRate = stats.total ? Math.round((stats.success / stats.total) * 100) : 0;

  return (
    <div className="animate-fade-in">
      <PageHeader title="Mission control" subtitle="Live telemetry across the last 24 hours." />
      <div className="p-4 sm:p-6 md:p-8 space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StatCard icon={Activity} label="Active runs" value={stats.active} accent="warning" pulse={stats.active > 0} />
          <StatCard icon={CheckCircle2} label="Success rate" value={`${successRate}%`} accent="success" />
          <StatCard icon={XCircle} label="Failures (24h)" value={stats.failed} accent="destructive" />
          <StatCard icon={Clock} label="Avg duration" value={stats.avgMs ? `${stats.avgMs}ms` : "—"} accent="primary" />
        </div>

        <Card className="surface p-6">
          <h2 className="font-semibold mb-4">Recent runs</h2>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs yet. <Link to="/workflows" className="text-primary hover:underline">Create a workflow</Link> to get started.</p>
          ) : (
            <div className="space-y-1">
              {recent.map(r => (
                <Link key={r.id} to={`/runs/${r.id}`} className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 transition-colors">
                  <StatusDot status={r.status} />
                  <div className="font-mono text-sm flex-1 truncate min-w-0">{r.workflows?.name ?? "workflow"}</div>
                  <div className="hidden sm:block text-xs text-muted-foreground font-mono">{r.duration_ms ? `${r.duration_ms}ms` : "—"}</div>
                  <div className="text-xs text-muted-foreground font-mono whitespace-nowrap">{new Date(r.created_at).toLocaleTimeString()}</div>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, accent, pulse }: any) {
  const colors: Record<string,string> = { success: "text-success", destructive: "text-destructive", warning: "text-warning", primary: "text-primary" };
  return (
    <Card className="surface p-5">
      <div className="flex items-center justify-between mb-2">
        <Icon className={`h-4 w-4 ${colors[accent]}`} />
        {pulse && <span className={`pulse-dot ${colors[accent]}`} />}
      </div>
      <div className="text-3xl font-bold font-mono">{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{label}</div>
    </Card>
  );
}

export function StatusDot({ status }: { status: string }) {
  const map: Record<string, string> = { success: "bg-success", failed: "bg-destructive", timeout: "bg-destructive", running: "bg-warning", pending: "bg-muted-foreground", cancelled: "bg-muted-foreground" };
  return <span className={`inline-block h-2 w-2 rounded-full ${map[status] ?? "bg-muted"} ${status === "running" ? "animate-pulse-soft" : ""}`} />;
}
