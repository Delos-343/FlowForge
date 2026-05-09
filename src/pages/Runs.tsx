import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader } from "@/components/AppLayout";
import { Card } from "@/components/ui/card";
import { Link } from "react-router-dom";
import { StatusDot } from "./Dashboard";

export default function Runs() {
  const { profile } = useAuth();
  const [items, setItems] = useState<any[]>([]);

  useEffect(() => {
    if (!profile) return;
    const load = async () => {
      const { data } = await supabase.from("runs")
        .select("id, status, duration_ms, created_at, trigger, workflow_version, workflows(name)")
        .eq("tenant_id", profile.tenant_id).order("created_at", { ascending: false }).limit(100);
      setItems(data ?? []);
    };
    load();
    const ch = supabase.channel("runs-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "runs", filter: `tenant_id=eq.${profile.tenant_id}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [profile]);

  return (
    <div className="animate-fade-in">
      <PageHeader title="Run history" subtitle={`${items.length} recent runs (live)`} />
      <div className="p-4 sm:p-6 md:p-8">
        <Card className="surface divide-y divide-border">
          {items.length === 0 && <div className="p-6 text-muted-foreground text-sm">No runs yet.</div>}
          {items.map(r => (
            <Link key={r.id} to={`/runs/${r.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-secondary/40 transition-colors">
              <StatusDot status={r.status} />
              <div className="font-mono text-sm flex-1 truncate">{r.workflows?.name}</div>
              <div className="text-xs font-mono text-muted-foreground">v{r.workflow_version}</div>
              <div className="text-xs font-mono text-muted-foreground">{r.trigger}</div>
              <div className="text-xs font-mono text-muted-foreground w-24 text-right">{r.duration_ms ? `${r.duration_ms}ms` : "…"}</div>
              <div className="text-xs font-mono text-muted-foreground w-44 text-right">{new Date(r.created_at).toLocaleString()}</div>
            </Link>
          ))}
        </Card>
      </div>
    </div>
  );
}
