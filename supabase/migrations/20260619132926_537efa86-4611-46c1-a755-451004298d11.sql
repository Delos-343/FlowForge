
-- Scope runs UPDATE policy to authenticated explicitly
DROP POLICY IF EXISTS "editors update runs" ON public.runs;
CREATE POLICY "editors update runs" ON public.runs
  FOR UPDATE TO authenticated
  USING (public.can_edit(auth.uid(), tenant_id))
  WITH CHECK (public.can_edit(auth.uid(), tenant_id));

-- Allow invited user to read their own pending invitation by email
CREATE POLICY "invited user reads own invitation" ON public.invitations
  FOR SELECT TO authenticated
  USING (lower(email) = lower((SELECT u.email FROM auth.users u WHERE u.id = auth.uid())));
