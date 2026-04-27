import { ReactNode } from "react";
import { NavLink, useNavigate, Outlet } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Workflow, LayoutDashboard, GitBranch, History, LogOut, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/workflows", icon: GitBranch, label: "Workflows" },
  { to: "/runs", icon: History, label: "Runs" },
  { to: "/builder", icon: Sparkles, label: "AI Builder" },
];

export default function AppLayout() {
  const { profile, roles, signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="min-h-screen flex w-full">
      <aside className="w-60 border-r border-sidebar-border bg-sidebar flex flex-col">
        <div className="p-5 flex items-center gap-2 border-b border-sidebar-border">
          <div className="h-8 w-8 rounded-md bg-gradient-primary grid place-items-center shadow-glow">
            <Workflow className="h-4 w-4 text-primary-foreground" />
          </div>
          <span className="font-mono font-semibold tracking-tight">FlowForge</span>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {nav.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to}
              className={({ isActive }) => cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                isActive ? "bg-sidebar-accent text-primary font-medium" : "text-sidebar-foreground hover:bg-sidebar-accent/60"
              )}>
              <Icon className="h-4 w-4" />{label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-sidebar-border space-y-2">
          <div className="px-2 text-xs">
            <div className="font-medium truncate">{profile?.display_name ?? "User"}</div>
            <div className="font-mono text-muted-foreground truncate">{roles.join(" · ") || "viewer"}</div>
          </div>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={async () => { await signOut(); navigate("/auth"); }}>
            <LogOut className="h-4 w-4 mr-2" />Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto"><Outlet /></main>
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <header className="flex items-start justify-between p-8 pb-6 border-b border-border">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="text-muted-foreground mt-1">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}
