
-- 1) Prevent tenant_id tampering via self-profile update (privilege escalation fix)
DROP POLICY IF EXISTS "update own profile" ON public.profiles;
CREATE POLICY "update own profile" ON public.profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND tenant_id = (SELECT p.tenant_id FROM public.profiles p WHERE p.id = auth.uid())
  );

-- 2) endpoint_health: explicit restrictive deny for client writes (service_role bypasses RLS)
DROP POLICY IF EXISTS "deny client insert endpoint_health" ON public.endpoint_health;
DROP POLICY IF EXISTS "deny client update endpoint_health" ON public.endpoint_health;
DROP POLICY IF EXISTS "deny client delete endpoint_health" ON public.endpoint_health;

CREATE POLICY "deny client insert endpoint_health" ON public.endpoint_health
  AS RESTRICTIVE FOR INSERT TO authenticated, anon
  WITH CHECK (false);

CREATE POLICY "deny client update endpoint_health" ON public.endpoint_health
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon
  USING (false) WITH CHECK (false);

CREATE POLICY "deny client delete endpoint_health" ON public.endpoint_health
  AS RESTRICTIVE FOR DELETE TO authenticated, anon
  USING (false);

-- 3) webhook_token: hide from general tenant SELECTs via column-level revoke,
--    expose only to editors/admins through a SECURITY DEFINER RPC.
REVOKE SELECT (webhook_token) ON public.workflows FROM authenticated;
REVOKE SELECT (webhook_token) ON public.workflows FROM anon;

CREATE OR REPLACE FUNCTION public.get_workflow_webhook_token(_workflow_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT w.webhook_token
  FROM public.workflows w
  WHERE w.id = _workflow_id
    AND public.can_edit(auth.uid(), w.tenant_id);
$$;

REVOKE EXECUTE ON FUNCTION public.get_workflow_webhook_token(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_workflow_webhook_token(uuid) TO authenticated;
