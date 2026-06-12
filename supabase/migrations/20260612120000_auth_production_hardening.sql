-- Production hardening for password-gated parent/classroom auth.

-- If a database was patched from schema.sql while the old overloaded
-- get_parent_checkin_context(integer) still existed, remove or rename that
-- stale public RPC so PostgREST cannot expose a carpool-number bypass.
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
    if exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = 'get_checkin_context_for_carpool'
        and pg_get_function_identity_arguments(p.oid) = 'p_carpool_number integer'
    ) then
      revoke execute on function public.get_parent_checkin_context(integer) from public, anon, authenticated;
      drop function public.get_parent_checkin_context(integer);
    else
      alter function public.get_parent_checkin_context(integer)
        rename to get_checkin_context_for_carpool;
    end if;
  end if;
end
$$;

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

create or replace function public.cancel_parent_check_in_request(
  p_requesting_carpool_number integer,
  p_student_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public.school_today();
  v_requesting_family_id uuid;
  v_bad_count integer;
  v_cancelled jsonb := '[]'::jsonb;
begin
  v_requesting_family_id := public.family_id_for_carpool(p_requesting_carpool_number);
  if v_requesting_family_id is null then
    raise exception 'Carpool number not found';
  end if;

  with requested_students as (
    select distinct unnest(coalesce(p_student_ids, '{}'::uuid[])) as student_id
  ),
  invalid as (
    select rs.student_id
    from requested_students rs
    left join public.allowed_students_for_family(v_requesting_family_id, v_today) allowed
      on allowed.student_id = rs.student_id
    where allowed.student_id is null
  )
  select count(*) into v_bad_count from invalid;

  if v_bad_count > 0 then
    raise exception 'One or more students are not authorized for this carpool';
  end if;

  with requested_students as (
    select distinct unnest(coalesce(p_student_ids, '{}'::uuid[])) as student_id
  ),
  allowed_students as (
    select allowed.student_id
    from public.allowed_students_for_family(v_requesting_family_id, v_today) allowed
    join requested_students rs on rs.student_id = allowed.student_id
  ),
  updated as (
    update public.daily_status ds
    set
      status = 'WAITING',
      called_at = null,
      called_by = null,
      checked_in_by = null,
      pickup_family_id = null,
      pickup_family_label = null
    from allowed_students allowed
    where ds.student_id = allowed.student_id
      and ds.date = v_today
      and ds.status = 'CALLED'
      and ds.called_by = 'parent'
      and ds.pickup_family_id = v_requesting_family_id
    returning ds.student_id
  )
  select coalesce(
    jsonb_agg(u.student_id order by u.student_id),
    '[]'::jsonb
  )
  into v_cancelled
  from updated u;

  return jsonb_build_object(
    'cancelled_student_ids', v_cancelled
  );
end;
$$;

revoke execute on function public.write_pickup_authorization_audit(uuid, text, text, uuid, uuid, date, date, uuid[], jsonb) from public, anon, authenticated;
revoke execute on function public.parent_reping_cooldown_students(text, uuid[], date) from public, anon, authenticated;
revoke execute on function public.get_checkin_context_for_carpool(integer) from public, anon, authenticated;
revoke execute on function public.cancel_parent_check_in_request(integer, uuid[]) from public, anon, authenticated;
revoke execute on function public.get_parent_checkin_context() from public, anon;
revoke execute on function public.staff_get_parent_checkin_context(integer) from public, anon;

grant execute on function public.get_checkin_context_for_carpool(integer) to service_role;
grant execute on function public.get_parent_checkin_context() to authenticated;
grant execute on function public.staff_get_parent_checkin_context(integer) to authenticated;
grant execute on function public.cancel_parent_check_in_request(uuid[]) to authenticated;
