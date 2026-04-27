
-- ============================================================
-- ENUMS
-- ============================================================
CREATE TYPE public.app_role AS ENUM ('admin', 'editor', 'viewer');
CREATE TYPE public.run_status AS ENUM ('pending', 'running', 'success', 'failed', 'cancelled', 'timeout');
CREATE TYPE public.step_status AS ENUM ('pending', 'running', 'success', 'failed', 'skipped', 'retrying');
CREATE TYPE public.trigger_type AS ENUM ('manual', 'schedule', 'webhook');
CREATE TYPE public.log_level AS ENUM ('debug', 'info', 'warn', 'error');

-- ============================================================
-- TENANTS
-- ============================================================
CREATE TABLE public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- PROFILES (no FK to auth.users per guidelines; id matches auth uid)
-- ============================================================
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  email TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX profiles_tenant_idx ON public.profiles(tenant_id);

-- ============================================================
-- USER ROLES
-- ============================================================
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id, role)
);
CREATE INDEX user_roles_user_idx ON public.user_roles(user_id);

-- ============================================================
-- SECURITY DEFINER HELPERS
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_user_tenant(_user_id UUID)
RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT tenant_id FROM public.profiles WHERE id = _user_id LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _tenant UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND tenant_id = _tenant AND role = _role
  );
$$;

CREATE OR REPLACE FUNCTION public.can_edit(_user_id UUID, _tenant UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND tenant_id = _tenant AND role IN ('admin','editor')
  );
$$;

-- ============================================================
-- WORKFLOWS
-- ============================================================
CREATE TABLE public.workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  current_version INT NOT NULL DEFAULT 1,
  cron_expression TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workflows_tenant_idx ON public.workflows(tenant_id);
CREATE INDEX workflows_tenant_active_idx ON public.workflows(tenant_id, is_active);

-- ============================================================
-- WORKFLOW VERSIONS (immutable history)
-- ============================================================
CREATE TABLE public.workflow_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  version INT NOT NULL,
  definition JSONB NOT NULL, -- { nodes: [...], edges: [...] }
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);
CREATE INDEX workflow_versions_workflow_idx ON public.workflow_versions(workflow_id, version DESC);

-- ============================================================
-- RUNS
-- ============================================================
CREATE TABLE public.runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  workflow_version INT NOT NULL,
  status public.run_status NOT NULL DEFAULT 'pending',
  trigger public.trigger_type NOT NULL DEFAULT 'manual',
  triggered_by UUID,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms INT,
  error TEXT,
  ai_diagnosis TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Composite index for the most common query: list recent runs in tenant
CREATE INDEX runs_tenant_created_idx ON public.runs(tenant_id, created_at DESC);
CREATE INDEX runs_workflow_created_idx ON public.runs(workflow_id, created_at DESC);
CREATE INDEX runs_tenant_status_idx ON public.runs(tenant_id, status) WHERE status IN ('pending','running');

-- ============================================================
-- STEP RUNS
-- ============================================================
CREATE TABLE public.step_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL, -- node id from DAG
  step_type TEXT NOT NULL,
  status public.step_status NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  output JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX step_runs_run_idx ON public.step_runs(run_id);
CREATE INDEX step_runs_tenant_idx ON public.step_runs(tenant_id);

-- ============================================================
-- RUN LOGS (high-volume append-only)
-- ============================================================
CREATE TABLE public.run_logs (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  step_key TEXT,
  level public.log_level NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX run_logs_run_created_idx ON public.run_logs(run_id, created_at);
CREATE INDEX run_logs_tenant_created_idx ON public.run_logs(tenant_id, created_at DESC);

-- ============================================================
-- ENABLE RLS
-- ============================================================
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.step_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_logs ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RLS: TENANTS
-- ============================================================
CREATE POLICY "members view own tenant" ON public.tenants FOR SELECT
  USING (id = public.get_user_tenant(auth.uid()));

-- ============================================================
-- RLS: PROFILES
-- ============================================================
CREATE POLICY "view own profile" ON public.profiles FOR SELECT
  USING (id = auth.uid() OR tenant_id = public.get_user_tenant(auth.uid()));
CREATE POLICY "update own profile" ON public.profiles FOR UPDATE
  USING (id = auth.uid());

-- ============================================================
-- RLS: USER ROLES
-- ============================================================
CREATE POLICY "view roles in tenant" ON public.user_roles FOR SELECT
  USING (tenant_id = public.get_user_tenant(auth.uid()));
CREATE POLICY "admins manage roles" ON public.user_roles FOR ALL
  USING (public.has_role(auth.uid(), tenant_id, 'admin'))
  WITH CHECK (public.has_role(auth.uid(), tenant_id, 'admin'));

-- ============================================================
-- RLS: WORKFLOWS
-- ============================================================
CREATE POLICY "tenant view workflows" ON public.workflows FOR SELECT
  USING (tenant_id = public.get_user_tenant(auth.uid()));
CREATE POLICY "editors create workflows" ON public.workflows FOR INSERT
  WITH CHECK (public.can_edit(auth.uid(), tenant_id) AND created_by = auth.uid());
CREATE POLICY "editors update workflows" ON public.workflows FOR UPDATE
  USING (public.can_edit(auth.uid(), tenant_id));
CREATE POLICY "admins delete workflows" ON public.workflows FOR DELETE
  USING (public.has_role(auth.uid(), tenant_id, 'admin'));

-- ============================================================
-- RLS: WORKFLOW VERSIONS
-- ============================================================
CREATE POLICY "tenant view versions" ON public.workflow_versions FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.workflows w
    WHERE w.id = workflow_id AND w.tenant_id = public.get_user_tenant(auth.uid())
  ));
CREATE POLICY "editors create versions" ON public.workflow_versions FOR INSERT
  WITH CHECK (
    created_by = auth.uid() AND
    EXISTS (
      SELECT 1 FROM public.workflows w
      WHERE w.id = workflow_id AND public.can_edit(auth.uid(), w.tenant_id)
    )
  );

-- ============================================================
-- RLS: RUNS
-- ============================================================
CREATE POLICY "tenant view runs" ON public.runs FOR SELECT
  USING (tenant_id = public.get_user_tenant(auth.uid()));
CREATE POLICY "editors trigger runs" ON public.runs FOR INSERT
  WITH CHECK (public.can_edit(auth.uid(), tenant_id));
CREATE POLICY "editors update runs" ON public.runs FOR UPDATE
  USING (public.can_edit(auth.uid(), tenant_id));

-- ============================================================
-- RLS: STEP RUNS
-- ============================================================
CREATE POLICY "tenant view step runs" ON public.step_runs FOR SELECT
  USING (tenant_id = public.get_user_tenant(auth.uid()));

-- ============================================================
-- RLS: RUN LOGS
-- ============================================================
CREATE POLICY "tenant view logs" ON public.run_logs FOR SELECT
  USING (tenant_id = public.get_user_tenant(auth.uid()));

-- ============================================================
-- TRIGGER: updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER workflows_updated BEFORE UPDATE ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============================================================
-- TRIGGER: bootstrap tenant + profile + admin role on signup
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  new_tenant_id UUID;
  base_slug TEXT;
  unique_slug TEXT;
  display TEXT;
BEGIN
  display := COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1));
  base_slug := lower(regexp_replace(coalesce(display, 'workspace'), '[^a-z0-9]+', '-', 'g'));
  unique_slug := base_slug || '-' || substr(NEW.id::text, 1, 8);

  INSERT INTO public.tenants (name, slug)
  VALUES (display || '''s Workspace', unique_slug)
  RETURNING id INTO new_tenant_id;

  INSERT INTO public.profiles (id, tenant_id, email, display_name)
  VALUES (NEW.id, new_tenant_id, NEW.email, display);

  INSERT INTO public.user_roles (user_id, tenant_id, role)
  VALUES (NEW.id, new_tenant_id, 'admin');

  RETURN NEW;
END $$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- REALTIME
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.runs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.step_runs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.run_logs;

ALTER TABLE public.runs REPLICA IDENTITY FULL;
ALTER TABLE public.step_runs REPLICA IDENTITY FULL;
