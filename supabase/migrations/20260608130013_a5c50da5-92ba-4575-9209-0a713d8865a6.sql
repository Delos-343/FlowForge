
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ── workflows: scheduling metadata ───────────────────────────
ALTER TABLE public.workflows
  ADD COLUMN IF NOT EXISTS next_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_scheduled_at timestamptz;

CREATE INDEX IF NOT EXISTS workflows_due_idx
  ON public.workflows (next_run_at)
  WHERE is_active = true AND cron_expression IS NOT NULL;

-- ── runs: cancellation support ───────────────────────────────
ALTER TABLE public.runs
  ADD COLUMN IF NOT EXISTS cancellation_requested boolean NOT NULL DEFAULT false;

-- ── invitations ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  role app_role NOT NULL DEFAULT 'editor',
  token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
  invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invitations_tenant_idx ON public.invitations(tenant_id);
CREATE INDEX IF NOT EXISTS invitations_email_idx ON public.invitations(lower(email));

GRANT SELECT, INSERT, UPDATE ON public.invitations TO authenticated;
GRANT ALL ON public.invitations TO service_role;

ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

-- Admins can manage invites in their tenant
CREATE POLICY "admins view tenant invites"
  ON public.invitations FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), tenant_id, 'admin'));

CREATE POLICY "admins create tenant invites"
  ON public.invitations FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), tenant_id, 'admin')
    AND invited_by = auth.uid()
  );

CREATE POLICY "admins update tenant invites"
  ON public.invitations FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), tenant_id, 'admin'))
  WITH CHECK (public.has_role(auth.uid(), tenant_id, 'admin'));

CREATE TRIGGER touch_invitations BEFORE UPDATE ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Allow editors to request cancellation (UPDATE policy already covers their tenant? check)
-- Add a dedicated policy in case existing runs policies don't permit UPDATE.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='runs' AND policyname='editors cancel runs'
  ) THEN
    CREATE POLICY "editors cancel runs"
      ON public.runs FOR UPDATE TO authenticated
      USING (public.can_edit(auth.uid(), tenant_id))
      WITH CHECK (public.can_edit(auth.uid(), tenant_id));
  END IF;
END $$;

-- Accept invitation (security definer): claims invite, attaches role
CREATE OR REPLACE FUNCTION public.accept_invitation(_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv public.invitations%ROWTYPE;
  uid uuid := auth.uid();
  email text;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  SELECT email INTO email FROM auth.users WHERE id = uid;

  SELECT * INTO inv FROM public.invitations
   WHERE token = _token AND status = 'pending' AND expires_at > now()
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invite_invalid');
  END IF;

  IF lower(inv.email) <> lower(email) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'email_mismatch');
  END IF;

  -- Move user to invited tenant + add role
  UPDATE public.profiles SET tenant_id = inv.tenant_id WHERE id = uid;
  INSERT INTO public.user_roles (user_id, tenant_id, role)
    VALUES (uid, inv.tenant_id, inv.role)
    ON CONFLICT (user_id, tenant_id, role) DO NOTHING;

  UPDATE public.invitations
     SET status = 'accepted', accepted_at = now()
   WHERE id = inv.id;

  RETURN jsonb_build_object('ok', true, 'tenant_id', inv.tenant_id);
END $$;

GRANT EXECUTE ON FUNCTION public.accept_invitation(text) TO authenticated;
