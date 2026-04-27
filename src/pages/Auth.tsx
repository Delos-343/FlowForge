import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Workflow, Loader2 } from "lucide-react";

export default function Auth() {
  const nav = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) nav("/dashboard", { replace: true });
    });
  }, [nav]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email, password,
          options: { emailRedirectTo: `${window.location.origin}/dashboard`, data: { display_name: name } },
        });
        if (error) throw error;
        toast.success("Account created. Signing you in…");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      nav("/dashboard", { replace: true });
    } catch (err: any) {
      toast.error(err.message ?? "Auth failed");
    } finally {
      setLoading(false);
    }
  };

  const google = async () => {
    const r = await lovable.auth.signInWithOAuth("google", { redirect_uri: `${window.location.origin}/dashboard` });
    if (r.error) toast.error(r.error.message ?? "Google sign-in failed");
  };

  return (
    <main className="min-h-screen grid lg:grid-cols-2">
      <section className="hidden lg:flex flex-col justify-between p-12 bg-gradient-surface border-r border-border">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-lg bg-gradient-primary grid place-items-center shadow-glow">
            <Workflow className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="font-mono text-lg font-semibold tracking-tight">FlowForge</span>
        </div>
        <div className="space-y-6">
          <h1 className="text-5xl font-bold leading-tight">
            Orchestrate workflows.<br />
            <span className="text-primary glow-text">In real time.</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-md">
            Define DAGs, watch every step light up live, and let AI compose workflows from plain English.
          </p>
          <div className="grid grid-cols-3 gap-4 pt-6">
            {["DAG executor","Realtime telemetry","AI builder"].map(t => (
              <div key={t} className="surface px-4 py-3">
                <div className="text-xs font-mono text-primary">●</div>
                <div className="text-sm mt-1">{t}</div>
              </div>
            ))}
          </div>
        </div>
        <p className="text-xs font-mono text-muted-foreground">v1.0 · interview build</p>
      </section>

      <section className="flex items-center justify-center p-6">
        <Card className="w-full max-w-md surface p-8 space-y-6 animate-fade-in">
          <header>
            <h2 className="text-2xl font-bold">{mode === "signin" ? "Welcome back" : "Create your workspace"}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {mode === "signin" ? "Sign in to continue." : "Each new account gets its own tenant."}
            </p>
          </header>

          <Button type="button" variant="outline" className="w-full" onClick={google}>
            <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24"><path fill="currentColor" d="M21.35 11.1H12v3.2h5.35c-.5 2.4-2.6 4.1-5.35 4.1a6.4 6.4 0 1 1 0-12.8c1.6 0 3.05.6 4.15 1.55l2.4-2.4A9.6 9.6 0 1 0 12 21.6c5.55 0 9.6-3.9 9.6-9.4 0-.7-.05-1.1-.25-1.1z"/></svg>
            Continue with Google
          </Button>

          <div className="relative"><div className="absolute inset-0 flex items-center"><span className="w-full border-t border-border" /></div><div className="relative flex justify-center text-xs"><span className="bg-card px-2 text-muted-foreground font-mono">OR</span></div></div>

          <form onSubmit={submit} className="space-y-4">
            {mode === "signup" && (
              <div className="space-y-2"><Label htmlFor="name">Display name</Label><Input id="name" value={name} onChange={e => setName(e.target.value)} required /></div>
            )}
            <div className="space-y-2"><Label htmlFor="email">Email</Label><Input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
            <div className="space-y-2"><Label htmlFor="password">Password</Label><Input id="password" type="password" minLength={6} value={password} onChange={e => setPassword(e.target.value)} required /></div>
            <Button type="submit" className="w-full bg-gradient-primary text-primary-foreground hover:opacity-90" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {mode === "signin" ? "Sign in" : "Create workspace"}
            </Button>
          </form>

          <button onClick={() => setMode(mode === "signin" ? "signup" : "signin")} className="text-sm text-muted-foreground hover:text-primary w-full text-center">
            {mode === "signin" ? "No account? Create one" : "Already have an account? Sign in"}
          </button>
        </Card>
      </section>
    </main>
  );
}
