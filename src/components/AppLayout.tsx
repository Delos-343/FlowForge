import { ReactNode, useState } from "react";
import { NavLink, useNavigate, Outlet } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Workflow, LayoutDashboard, GitBranch, History, LogOut, Sparkles, Menu } from "lucide-react";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/workflows", icon: GitBranch, label: "Workflows" },
  { to: "/runs", icon: History, label: "Runs" },
  { to: "/builder", icon: Sparkles, label: "AI Builder" },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { profile, roles, signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="h-full flex flex-col bg-sidebar">
      <div className="p-5 flex items-center gap-2 border-b border-sidebar-border">
        <div className="h-8 w-8 rounded-md bg-gradient-primary grid place-items-center shadow-glow">
          <Workflow className="h-4 w-4 text-primary-foreground" />
        </div>
        <span className="font-mono font-semibold tracking-tight">FlowForge</span>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {nav.map(({ to, icon: Icon, label }) => (
          <NavLink key={to} to={to} onClick={onNavigate}
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
        <Button variant="ghost" size="sm" className="w-full justify-start"
          onClick={async () => { await signOut(); onNavigate?.(); navigate("/auth"); }}>
          <LogOut className="h-4 w-4 mr-2" />Sign out
        </Button>
      </div>
    </div>
  );
}

export default function AppLayout() {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen flex w-full">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-60 border-r border-sidebar-border flex-col">
        <SidebarContent />
      </aside>

      <main className="flex-1 min-w-0 overflow-auto">
        {/* Mobile top bar */}
        <div className="md:hidden sticky top-0 z-40 flex items-center gap-2 px-4 h-14 border-b border-border bg-background/95 backdrop-blur">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open menu"><Menu className="h-5 w-5" /></Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-64 bg-sidebar border-sidebar-border">
              <SidebarContent onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-md bg-gradient-primary grid place-items-center shadow-glow">
              <Workflow className="h-3.5 w-3.5 text-primary-foreground" />
            </div>
            <span className="font-mono font-semibold tracking-tight">FlowForge</span>
          </div>
        </div>
        <Outlet />
      </main>
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 p-4 sm:p-6 md:p-8 pb-4 sm:pb-6 border-b border-border">
      <div className="min-w-0">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight truncate">{title}</h1>
        {subtitle && <p className="text-sm sm:text-base text-muted-foreground mt-1">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-wrap gap-2">{action}</div>}
    </header>
  );
}
