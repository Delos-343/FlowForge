
-- Tighten profiles SELECT policy
DROP POLICY IF EXISTS "view own profile" ON public.profiles;
CREATE POLICY "view own or admin reads tenant profiles" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR public.has_role(auth.uid(), tenant_id, 'admin'::public.app_role)
  );

-- Restrictive deny baseline for step_runs writes from client roles
CREATE POLICY "deny client insert step_runs" ON public.step_runs
  AS RESTRICTIVE FOR INSERT TO anon, authenticated
  WITH CHECK (false);

CREATE POLICY "deny client update step_runs" ON public.step_runs
  AS RESTRICTIVE FOR UPDATE TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny client delete step_runs" ON public.step_runs
  AS RESTRICTIVE FOR DELETE TO anon, authenticated
  USING (false);
