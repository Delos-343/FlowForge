
-- 1) Caller validation in RLS helper functions: ensure _user_id matches auth.uid()
--    so they cannot be probed for arbitrary users via RPC.
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _tenant uuid, _role public.app_role)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR _user_id IS DISTINCT FROM auth.uid() THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND tenant_id = _tenant AND role = _role
  );
END $$;

CREATE OR REPLACE FUNCTION public.can_edit(_user_id uuid, _tenant uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR _user_id IS DISTINCT FROM auth.uid() THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND tenant_id = _tenant AND role IN ('admin','editor')
  );
END $$;

CREATE OR REPLACE FUNCTION public.get_user_tenant(_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR _user_id IS DISTINCT FROM auth.uid() THEN
    RETURN NULL;
  END IF;
  RETURN (SELECT tenant_id FROM public.profiles WHERE id = _user_id LIMIT 1);
END $$;

-- 2) Reinforce column-level protection for workflows.webhook_token so tenant
--    members cannot read it via the generic SELECT policy. Tokens remain
--    accessible only through public.get_workflow_webhook_token() (which
--    requires can_edit) and to service_role from edge functions.
REVOKE SELECT (webhook_token) ON public.workflows FROM authenticated, anon, PUBLIC;
GRANT SELECT (
  id, tenant_id, created_by, name, description, is_active,
  current_version, cron_expression, next_run_at, last_scheduled_at,
  created_at, updated_at
) ON public.workflows TO authenticated;
