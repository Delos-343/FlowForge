import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Plus, Play, History as HistoryIcon, Trash2 } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function Workflows() {
  const { profile, canEdit, isAdmin } = useAuth();
  const nav = useNavigate();
  const [items, setItems] = useState<any[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState("");

  const load = async () => {
    if (!profile) return;
    const { data } = await supabase.from("workflows").select("*").eq("tenant_id", profile.tenant_id).order("updated_at", { ascending: false });
    setItems(data ?? []);
  };
  useEffect(() => { load(); }, [profile]);

  const create = async () => {
    if (!profile || !name.trim()) return;
    const { data: wf, error } = await supabase.from("workflows").insert({
      tenant_id: profile.tenant_id, name: name.trim(), created_by: profile.id, current_version: 1,
    }).select().single();
    if (error) return toast.error(error.message);
    await supabase.from("workflow_versions").insert({
      workflow_id: wf.id, version: 1, created_by: profile.id,
      definition: { nodes: [{ id: "start", name: "Start", step: { type: "delay", ms: 100 } }], edges: [], timeout_ms: 60000 },
    });
    toast.success("Workflow created");
    setNewOpen(false); setName("");
    nav(`/workflows/${wf.id}`);
  };

  const trigger = async (id: string) => {
    const { data: { session } } = await supabase.auth.getSession();
    const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/run-workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ workflow_id: id }),
    });
    const j = await r.json();
    if (!r.ok) return toast.error(j.error ?? "Run failed");
    toast.success("Run started");
    nav(`/runs/${j.run_id}`);
  };

  const remove = async (id: string) => {
    const { error } = await supabase.from("workflows").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Deleted"); load();
  };

  return (
    <div className="animate-fade-in">
      <PageHeader title="Workflows" subtitle="Define, version, and trigger your DAGs." action={
        canEdit && <Button onClick={() => setNewOpen(true)} className="bg-gradient-primary text-primary-foreground"><Plus className="h-4 w-4 mr-2" />New workflow</Button>
      } />
      <div className="p-4 sm:p-6 md:p-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.length === 0 && <p className="text-muted-foreground">No workflows yet.</p>}
        {items.map(w => (
          <Card key={w.id} className="surface p-5 group hover:border-primary/40 transition-colors">
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <Link to={`/workflows/${w.id}`} className="font-semibold hover:text-primary truncate block">{w.name}</Link>
                <div className="text-xs font-mono text-muted-foreground mt-1">v{w.current_version} · updated {new Date(w.updated_at).toLocaleDateString()}</div>
              </div>
              <span className={`pulse-dot ${w.is_active ? "text-success" : "text-muted-foreground"}`} />
            </div>
            {w.description && <p className="text-sm text-muted-foreground mt-2 line-clamp-2">{w.description}</p>}
            <div className="flex items-center gap-2 mt-4">
              {canEdit && <Button size="sm" variant="default" onClick={() => trigger(w.id)}><Play className="h-3 w-3 mr-1" />Run</Button>}
              <Button size="sm" variant="ghost" asChild><Link to={`/workflows/${w.id}`}><HistoryIcon className="h-3 w-3 mr-1" />Open</Link></Button>
              {isAdmin && <Button size="sm" variant="ghost" className="ml-auto text-destructive" onClick={() => remove(w.id)}><Trash2 className="h-3 w-3" /></Button>}
            </div>
          </Card>
        ))}
      </div>

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New workflow</DialogTitle></DialogHeader>
          <div className="space-y-2"><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="My workflow" /></div>
          <DialogFooter><Button onClick={create} disabled={!name.trim()}>Create</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
