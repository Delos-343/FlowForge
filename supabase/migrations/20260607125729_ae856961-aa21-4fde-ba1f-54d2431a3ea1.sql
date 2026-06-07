
CREATE TABLE IF NOT EXISTS public.endpoint_health (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
  consecutive_failures INT NOT NULL DEFAULT 0,
  consecutive_successes INT NOT NULL DEFAULT 0,
  last_status INT,
  last_error TEXT,
  last_latency_ms INT,
  avg_latency_ms INT,
  last_checked_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  next_probe_at TIMESTAMPTZ,
  total_calls BIGINT NOT NULL DEFAULT 0,
  total_failures BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, host)
);

GRANT SELECT ON public.endpoint_health TO authenticated;
GRANT ALL ON public.endpoint_health TO service_role;

ALTER TABLE public.endpoint_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant members can read endpoint health"
  ON public.endpoint_health FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_user_tenant(auth.uid()));

CREATE TRIGGER endpoint_health_touch_updated_at
  BEFORE UPDATE ON public.endpoint_health
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX IF NOT EXISTS idx_endpoint_health_tenant_host
  ON public.endpoint_health (tenant_id, host);
