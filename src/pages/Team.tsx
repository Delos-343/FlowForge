import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Copy, UserPlus, Trash2, Shield } from "lucide-react";
import { toast } from "sonner";

type Member = { user_id: string; role: string; profile: { display_name: string | null; email: string | null } };
type Invite = { id: string; email: string; role: string; status: string; token: string; created_at: string; expires_at: string };

export default function Team() {
  const { profile, isAdmin } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "editor" | "viewer">("editor");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!profile) return;
    const { data: rs } = await supabase.from("user_roles")
      .select("user_id, role, profiles!inner(display_name, email)")
      .eq("tenant_id", profile.tenant_id);
    setMembers((rs ?? []).map((r: any) => ({ user_id: r.user_id, role: r.role, profile: r.profiles })));
    const { data: invs } = await supabase.from("invitations")
      .select("*").eq("tenant_id", profile.tenant_id).order("created_at", { ascending: false });
    setInvites((invs ?? []) as Invite[]);
  };
  useEffect(() => { load(); }, [profile?.tenant_id]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invite-user`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}`, origin: window.location.origin },
        body: JSON.stringify({ email, role }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      navigator.clipboard.writeText(j.accept_url).catch(() => {});
      toast.success("Invite created — link copied to clipboard");
      setEmail("");
      load();
    } catch (err: any) {
      toast.error(err.message ?? "failed");
    } finally { setBusy(false); }
  };

  const revokeInvite = async (id: string) => {
    await supabase.from("invitations").update({ status: "revoked" }).eq("id", id);
    load();
  };

  const changeRole = async (user_id: string, oldRole: string, newRole: string) => {
    if (!profile) return;
    await supabase.from("user_roles").delete().eq("user_id", user_id).eq("tenant_id", profile.tenant_id).eq("role", oldRole as any);
    await supabase.from("user_roles").insert([{ user_id, tenant_id: profile.tenant_id, role: newRole as any }]);
    toast.success("Role updated");
    load();
  };

  const removeMember = async (user_id: string) => {
    if (!profile) return;
    if (user_id === profile.id) return toast.error("Can't remove yourself");
    await supabase.from("user_roles").delete().eq("user_id", user_id).eq("tenant_id", profile.tenant_id);
    toast.success("Member removed");
    load();
  };

  return (
    <div className="animate-fade-in">
      <PageHeader title="Team" subtitle="Invite teammates and manage their workspace roles" />
      <div className="p-4 sm:p-6 md:p-8 space-y-6">
        {isAdmin && (
          <Card className="surface p-5">
            <form onSubmit={invite} className="grid sm:grid-cols-[1fr_160px_auto] gap-3 items-end">
              <div className="space-y-1.5">
                <Label htmlFor="iemail">Email</Label>
                <Input id="iemail" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" />
              </div>
              <div className="space-y-1.5">
                <Label>Role</Label>
                <Select value={role} onValueChange={(v: any) => setRole(v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="editor">Editor</SelectItem>
                    <SelectItem value="viewer">Viewer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={busy} className="bg-gradient-primary text-primary-foreground">
                <UserPlus className="h-4 w-4 mr-2" />Invite
              </Button>
            </form>
          </Card>
        )}

        <Card className="surface p-5">
          <h3 className="font-semibold mb-3 flex items-center gap-2"><Shield className="h-4 w-4" />Members</h3>
          <div className="space-y-1">
            {members.map((m) => (
              <div key={`${m.user_id}-${m.role}`} className="flex items-center gap-3 px-3 py-2 rounded bg-secondary/40">
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{m.profile?.display_name ?? "—"}</div>
                  <div className="text-xs text-muted-foreground font-mono truncate">{m.profile?.email}</div>
                </div>
                {isAdmin ? (
                  <Select defaultValue={m.role} onValueChange={(v) => changeRole(m.user_id, m.role, v)}>
                    <SelectTrigger className="w-28 h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">admin</SelectItem>
                      <SelectItem value="editor">editor</SelectItem>
                      <SelectItem value="viewer">viewer</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-xs font-mono px-2 py-1 rounded bg-secondary">{m.role}</span>
                )}
                {isAdmin && (
                  <Button size="sm" variant="ghost" onClick={() => removeMember(m.user_id)} className="text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
            {members.length === 0 && <div className="text-sm text-muted-foreground">No members</div>}
          </div>
        </Card>

        {isAdmin && (
          <Card className="surface p-5">
            <h3 className="font-semibold mb-3">Pending invitations</h3>
            <div className="space-y-1">
              {invites.filter((i) => i.status === "pending").map((i) => {
                const url = `${window.location.origin}/accept-invite?token=${i.token}`;
                return (
                  <div key={i.id} className="flex items-center gap-3 px-3 py-2 rounded bg-secondary/40">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{i.email}</div>
                      <div className="text-xs text-muted-foreground font-mono truncate">{i.role} · expires {new Date(i.expires_at).toLocaleDateString()}</div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(url); toast.success("Link copied"); }}>
                      <Copy className="h-3.5 w-3.5 mr-1" />Link
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => revokeInvite(i.id)} className="text-destructive">Revoke</Button>
                  </div>
                );
              })}
              {invites.filter((i) => i.status === "pending").length === 0 && <div className="text-sm text-muted-foreground">No pending invites</div>}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
