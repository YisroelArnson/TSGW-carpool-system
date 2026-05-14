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

grant execute on function public.cancel_parent_check_in_request(integer, uuid[]) to anon, authenticated;
