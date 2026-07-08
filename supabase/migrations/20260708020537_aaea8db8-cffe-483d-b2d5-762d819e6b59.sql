
create table if not exists public.rate_limit_counters (
  tenant_id uuid not null,
  bucket text not null,
  window_start timestamptz not null default now(),
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, bucket)
);

grant all on public.rate_limit_counters to service_role;

alter table public.rate_limit_counters enable row level security;

create or replace function public.check_rate_limit(
  _tenant_id uuid,
  _bucket text,
  _limit integer,
  _window_seconds integer default 60
)
returns table (allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  _now timestamptz := now();
  _row public.rate_limit_counters%rowtype;
  _new_count integer;
  _reset_at timestamptz;
begin
  insert into public.rate_limit_counters(tenant_id, bucket, window_start, count, updated_at)
  values (_tenant_id, _bucket, _now, 0, _now)
  on conflict (tenant_id, bucket) do nothing;

  select * into _row
  from public.rate_limit_counters
  where tenant_id = _tenant_id and bucket = _bucket
  for update;

  if _row.window_start + make_interval(secs => _window_seconds) <= _now then
    _row.window_start := _now;
    _row.count := 0;
  end if;

  _reset_at := _row.window_start + make_interval(secs => _window_seconds);

  if _row.count >= _limit then
    update public.rate_limit_counters
      set window_start = _row.window_start,
          count = _row.count,
          updated_at = _now
      where tenant_id = _tenant_id and bucket = _bucket;
    return query select false, 0, _reset_at;
    return;
  end if;

  _new_count := _row.count + 1;
  update public.rate_limit_counters
    set window_start = _row.window_start,
        count = _new_count,
        updated_at = _now
    where tenant_id = _tenant_id and bucket = _bucket;

  return query select true, greatest(_limit - _new_count, 0), _reset_at;
end;
$$;

revoke all on function public.check_rate_limit(uuid, text, integer, integer) from public;
revoke all on function public.check_rate_limit(uuid, text, integer, integer) from anon;
revoke all on function public.check_rate_limit(uuid, text, integer, integer) from authenticated;
grant execute on function public.check_rate_limit(uuid, text, integer, integer) to service_role;
