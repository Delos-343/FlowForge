import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader } from "@/components/AppLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import DagView from "@/components/DagView";
import { Sparkles, Loader2, Save } from "lucide-react";
import { toast } from "sonner";

const examples = [
  "Every morning at 9am, fetch the weather from an API and post it to a Slack webhook.",
  "When triggered, call GitHub API to fetch the latest release, wait 5 seconds, then notify our deploy webhook.",
  "Fetch user data from a CRM, transform it, and POST in parallel to billing and analytics.",
];

export default function AIBuilder() {
  const { profile, canEdit } = useAuth();
  const nav = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const generate = async () => {
    if (!prompt.trim()) return;
    setLoading(true); setResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-build-workflow`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ prompt }),
      });
      const j = await r.json();
      if (r.status === 429) return toast.error("Rate limited. Try again shortly.");
      if (r.status === 402) return toast.error("AI credits exhausted. Add credits in workspace settings.");
      if (!r.ok) return toast.error(j.error ?? "Generation failed");
      setResult(j);
    } finally { setLoading(false); }
  };

  const saveWorkflow = async () => {
    if (!profile || !result) return;
    const { data: wf, error } = await supabase.from("workflows").insert({
      tenant_id: profile.tenant_id, name: result.name, description: result.description, created_by: profile.id, current_version: 1,
    }).select().single();
    if (error) return toast.error(error.message);
    await supabase.from("workflow_versions").insert({
      workflow_id: wf.id, version: 1, created_by: profile.id, definition: result.dag,
    });
    toast.success("Workflow saved");
    nav(`/workflows/${wf.id}`);
  };

  return (
    <div className="animate-fade-in">
      <PageHeader title="AI workflow builder" subtitle="Describe what you want. We'll generate a valid DAG." />
      <div className="p-4 sm:p-6 md:p-8 grid lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          <Card className="surface p-5">
            <Textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="e.g. Every morning at 9am, fetch the weather and post to Slack…"
              className="h-40 font-mono text-sm" maxLength={1500} />
            <div className="flex items-center justify-between mt-3">
              <span className="text-xs font-mono text-muted-foreground">{prompt.length}/1500</span>
              <Button onClick={generate} disabled={loading || !prompt.trim()} className="bg-gradient-primary text-primary-foreground">
                {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
                Generate
              </Button>
            </div>
          </Card>
          <Card className="surface p-5">
            <div className="text-xs font-mono text-muted-foreground mb-2">EXAMPLES</div>
            <div className="space-y-1">
              {examples.map(e => (
                <button key={e} onClick={() => setPrompt(e)} className="text-left text-sm w-full px-3 py-2 rounded hover:bg-secondary/50 transition-colors">{e}</button>
              ))}
            </div>
          </Card>
        </div>
        <Card className="surface p-5">
          {!result && <div className="h-full grid place-items-center text-muted-foreground text-sm">Generated DAG will appear here.</div>}
          {result && (
            <div className="space-y-4 h-full flex flex-col">
              <div>
                <div className="text-xs font-mono text-muted-foreground">PROPOSED</div>
                <div className="text-lg font-semibold">{result.name}</div>
                {result.description && <p className="text-sm text-muted-foreground mt-1">{result.description}</p>}
              </div>
              <div className="flex-1 min-h-[300px]"><DagView dag={result.dag} height={300} /></div>
              {canEdit && (
                <Button onClick={saveWorkflow} className="bg-gradient-primary text-primary-foreground"><Save className="h-4 w-4 mr-2" />Save as workflow</Button>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
