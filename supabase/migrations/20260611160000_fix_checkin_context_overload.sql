-- Fix parent login / check-in page (HTTP 405 on get_parent_checkin_context).
--
-- Root cause: the parent and staff check-in-context wrappers were declared
-- STABLE, but they transitively perform a write -- they call
-- get_checkin_context_for_carpool(), which calls
-- prune_invalid_carpool_preset_students(), which runs a DELETE. PostgREST runs
-- STABLE/IMMUTABLE functions in a READ-ONLY transaction, so the DELETE failed
-- with SQLSTATE 25006 ("cannot execute DELETE in a read-only transaction"),
-- which PostgREST surfaces to the client as HTTP 405. The wrappers must be
-- VOLATILE so PostgREST runs them in a read/write transaction.
--
-- Secondary cleanup: the no-arg parent wrapper and the internal integer
-- implementation previously shared the name get_parent_checkin_context,
-- creating an overloaded function. Every other parent wrapper in this schema
-- uses a distinct name from its implementation; this renames the
-- implementation to get_checkin_context_for_carpool to match that pattern.

-- 1) De-overload: rename the internal implementation (idempotent).
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

-- 2) Recreate the wrappers as VOLATILE (they transitively DELETE via prune).
create or replace function public.get_parent_checkin_context()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  return public.get_checkin_context_for_carpool(public.require_current_parent_carpool_number());
end;
$$;

create or replace function public.staff_get_parent_checkin_context(p_carpool_number integer)
returns jsonb
language plpgsql
volatile
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
