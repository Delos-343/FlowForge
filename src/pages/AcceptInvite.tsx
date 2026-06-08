import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";

export default function AcceptInvite() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const token = sp.get("token");
  const [state, setState] = useState<"loading" | "needs_signin" | "ready" | "done" | "error">("loading");
  const [info, setInfo] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) { setState("error"); setError("Missing token"); return; }
    (async () => {
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invite-user?token=${token}`, {
        headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
      });
      const j = await r.json();
      if (!r.ok) { setState("error"); setError(j.error); return; }
      setInfo(j);
      const { data: { session } } = await supabase.auth.getSession();
      setState(session ? "ready" : "needs_signin");
    })();
  }, [token]);

  const accept = async () => {
    const { data, error } = await (supabase as any).rpc("accept_invitation", { _token: token });
    if (error || !data?.ok) { toast.error(data?.error ?? error?.message ?? "failed"); return; }
    setState("done");
    toast.success("Joined workspace");
    setTimeout(() => nav("/dashboard"), 800);
  };

  return (
    <main className="min-h-screen grid place-items-center p-4">
      <Card className="surface p-8 max-w-md w-full space-y-5">
        {state === "loading" && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading invitation…</div>}
        {state === "error" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-destructive"><AlertCircle className="h-5 w-5" /><span className="font-semibold">Invite unavailable</span></div>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        )}
        {(state === "needs_signin" || state === "ready") && info && (
          <div className="space-y-4">
            <header>
              <h1 className="text-2xl font-bold">Join {info.tenant_name}</h1>
              <p className="text-sm text-muted-foreground mt-1">You're invited as <span className="font-mono text-primary">{info.role}</span> using <span className="font-mono">{info.email}</span></p>
            </header>
            {state === "needs_signin" ? (
              <Button className="w-full bg-gradient-primary text-primary-foreground" onClick={() => nav(`/auth?next=/accept-invite?token=${token}`)}>
                Sign in to accept
              </Button>
            ) : (
              <Button className="w-full bg-gradient-primary text-primary-foreground" onClick={accept}>Accept invitation</Button>
            )}
          </div>
        )}
        {state === "done" && (
          <div className="flex items-center gap-2 text-success"><CheckCircle2 className="h-5 w-5" /><span>Joined. Redirecting…</span></div>
        )}
      </Card>
    </main>
  );
}
