-- Fix parent login: remove the get_parent_checkin_context() / (integer) overload.
--
-- The no-arg parent RPC and the internal integer implementation shared the same
-- name, so `public.get_parent_checkin_context` was an overloaded function with
-- two signatures of different volatility (no-arg STABLE, integer VOLATILE).
-- PostgREST could not route the authenticated no-arg POST and returned 405,
-- which threw in the parent app right after a successful sign-in (looked like
-- "can't log in"). Every other parent wrapper in this schema uses a distinct
-- name from its implementation; this renames the implementation to match that
-- pattern so `get_parent_checkin_context` has a single (no-arg) signature.

-- Idempotent rename: only rename if the (integer) overload still exists.
do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'get_parent_checkin_context'
      and pg_get_function_identity_arguments(p.oid) = 'p_carpool_number integer'
  ) then
    alter function public.get_parent_checkin_context(integer)
      rename to get_checkin_context_for_carpool;
  end if;
end
$$;

-- Parent no-arg wrapper -> call the renamed implementation.
create or replace function public.get_parent_checkin_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return public.get_checkin_context_for_carpool(public.require_current_parent_carpool_number());
end;
$$;

-- Staff wrapper -> call the renamed implementation.
create or replace function public.staff_get_parent_checkin_context(p_carpool_number integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_spotter_or_admin() then
    raise exception 'Staff authentication required';
  end if;
  return public.get_checkin_context_for_carpool(p_carpool_number);
end;
$$;

-- Keep the internal implementation callable only via the security-definer
-- wrappers above (the rename preserved its prior grants; re-assert for safety).
revoke execute on function public.get_checkin_context_for_carpool(integer) from public, anon, authenticated;
grant execute on function public.get_checkin_context_for_carpool(integer) to service_role;

-- Re-assert the exposed grants on the wrappers (no-op if already present).
grant execute on function public.get_parent_checkin_context() to authenticated;
grant execute on function public.staff_get_parent_checkin_context(integer) to authenticated;
