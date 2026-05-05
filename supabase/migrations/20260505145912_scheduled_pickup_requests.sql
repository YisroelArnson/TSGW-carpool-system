create table if not exists public.scheduled_pickup_requests (
  id uuid primary key default gen_random_uuid(),
  requesting_family_id uuid not null references public.families(id) on delete cascade,
  requesting_carpool_number integer not null,
  targets jsonb not null,
  target_count integer not null default 0,
  send_at timestamptz not null,
  status text not null default 'pending',
  called_by text not null default 'parent',
  checked_in_by text,
  result jsonb,
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  processed_at timestamptz,
  cancelled_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduled_pickup_requests_status_check
    check (status in ('pending', 'processing', 'sent', 'cancelled', 'failed')),
  constraint scheduled_pickup_requests_called_by_check
    check (called_by = 'parent'),
  constraint scheduled_pickup_requests_targets_array_check
    check (jsonb_typeof(targets) = 'array'),
  constraint scheduled_pickup_requests_target_count_check
    check (target_count > 0)
);

create index if not exists idx_scheduled_pickup_requests_status_send_at
  on public.scheduled_pickup_requests(status, send_at);
create index if not exists idx_scheduled_pickup_requests_family_created
  on public.scheduled_pickup_requests(requesting_family_id, created_at desc);
create unique index if not exists idx_scheduled_pickup_requests_one_pending_family
  on public.scheduled_pickup_requests(requesting_family_id)
  where status = 'pending';

drop trigger if exists trg_scheduled_pickup_requests_updated_at on public.scheduled_pickup_requests;
create trigger trg_scheduled_pickup_requests_updated_at
before update on public.scheduled_pickup_requests
for each row execute function public.set_updated_at();

create or replace function public.scheduled_pickup_target_count(p_targets jsonb)
returns integer
language sql
immutable
as $$
  with submitted_targets as (
    select distinct sid.student_id
    from jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) item
    cross join lateral (
      select jsonb_array_elements_text(item->'student_ids')::uuid as student_id
    ) sid
  )
  select count(*)::integer from submitted_targets;
$$;

create or replace function public.scheduled_pickup_request_response(p_request_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'request_id', spr.id,
    'status', spr.status,
    'send_at', spr.send_at,
    'target_count', spr.target_count,
    'targets', spr.targets,
    'created_at', spr.created_at,
    'last_error', spr.last_error,
    'result', spr.result
  )
  from public.scheduled_pickup_requests spr
  where spr.id = p_request_id;
$$;

create or replace function public.get_pending_scheduled_pickup_request(p_requesting_carpool_number integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_requesting_family_id uuid;
  v_response jsonb := null;
begin
  v_requesting_family_id := public.family_id_for_carpool(p_requesting_carpool_number);
  if v_requesting_family_id is null then
    raise exception 'Carpool number not found';
  end if;

  select public.scheduled_pickup_request_response(spr.id)
  into v_response
  from public.scheduled_pickup_requests spr
  where spr.requesting_family_id = v_requesting_family_id
    and spr.status = 'pending'
  order by spr.send_at
  limit 1;

  return v_response;
end;
$$;

create or replace function public.create_scheduled_pickup_request(
  p_requesting_carpool_number integer,
  p_targets jsonb,
  p_send_at timestamptz,
  p_checked_in_by text default null
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
  v_target_count integer;
  v_request_id uuid;
  v_checked_in_by text := nullif(btrim(p_checked_in_by), '');
begin
  if p_send_at is null then
    raise exception 'Choose when to send the pickup request';
  end if;

  if p_send_at < now() + interval '30 seconds' then
    raise exception 'Choose a send time at least 30 seconds from now';
  end if;

  if p_send_at > now() + interval '2 hours' then
    raise exception 'Scheduled pickup requests can be up to 2 hours ahead';
  end if;

  if jsonb_typeof(coalesce(p_targets, 'null'::jsonb)) <> 'array' then
    raise exception 'Invalid pickup request';
  end if;

  v_target_count := public.scheduled_pickup_target_count(p_targets);
  if v_target_count <= 0 then
    raise exception 'Choose at least one child';
  end if;

  v_requesting_family_id := public.family_id_for_carpool(p_requesting_carpool_number);
  if v_requesting_family_id is null then
    raise exception 'Carpool number not found';
  end if;

  with submitted_targets as (
    select
      (item->>'family_id')::uuid as family_id,
      sid.student_id
    from jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) item
    cross join lateral (
      select jsonb_array_elements_text(item->'student_ids')::uuid as student_id
    ) sid
  ),
  allowed_students as (
    select *
    from public.allowed_students_for_family(v_requesting_family_id, v_today)
  ),
  invalid as (
    select st.student_id
    from submitted_targets st
    left join allowed_students a
      on a.family_id = st.family_id
     and a.student_id = st.student_id
    where a.student_id is null
  )
  select count(*) into v_bad_count from invalid;

  if v_bad_count > 0 then
    raise exception 'One or more students are not authorized for this carpool';
  end if;

  update public.scheduled_pickup_requests
  set
    status = 'cancelled',
    cancelled_at = now(),
    last_error = 'Replaced by a newer scheduled pickup request'
  where requesting_family_id = v_requesting_family_id
    and status = 'pending';

  insert into public.scheduled_pickup_requests (
    requesting_family_id,
    requesting_carpool_number,
    targets,
    target_count,
    send_at,
    checked_in_by
  ) values (
    v_requesting_family_id,
    p_requesting_carpool_number,
    p_targets,
    v_target_count,
    p_send_at,
    coalesce(v_checked_in_by, 'Parent')
  )
  returning id into v_request_id;

  return public.scheduled_pickup_request_response(v_request_id);
end;
$$;

create or replace function public.cancel_scheduled_pickup_request(
  p_request_id uuid,
  p_requesting_carpool_number integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requesting_family_id uuid;
  v_request_id uuid;
begin
  v_requesting_family_id := public.family_id_for_carpool(p_requesting_carpool_number);
  if v_requesting_family_id is null then
    raise exception 'Carpool number not found';
  end if;

  update public.scheduled_pickup_requests
  set
    status = 'cancelled',
    cancelled_at = now()
  where id = p_request_id
    and requesting_family_id = v_requesting_family_id
    and status = 'pending'
  returning id into v_request_id;

  if v_request_id is null then
    raise exception 'Scheduled pickup request not found';
  end if;

  return public.scheduled_pickup_request_response(v_request_id);
end;
$$;

create or replace function public.process_due_scheduled_pickup_requests(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request record;
  v_result jsonb;
  v_processed integer := 0;
  v_sent integer := 0;
  v_failed integer := 0;
begin
  for v_request in
    update public.scheduled_pickup_requests spr
    set
      status = 'processing',
      attempt_count = spr.attempt_count + 1,
      last_attempt_at = now(),
      last_error = null
    where spr.id in (
      select due.id
      from public.scheduled_pickup_requests due
      where due.status = 'pending'
        and due.send_at <= now()
      order by due.send_at, due.created_at
      limit greatest(1, least(coalesce(p_limit, 25), 100))
      for update skip locked
    )
    returning spr.*
  loop
    v_processed := v_processed + 1;

    begin
      v_result := public.submit_check_in_request(
        v_request.requesting_carpool_number,
        v_request.targets,
        'parent',
        v_request.checked_in_by
      );

      update public.scheduled_pickup_requests
      set
        status = 'sent',
        result = v_result,
        processed_at = now()
      where id = v_request.id;

      v_sent := v_sent + 1;
    exception
      when others then
        update public.scheduled_pickup_requests
        set
          status = 'failed',
          last_error = sqlerrm,
          processed_at = now()
        where id = v_request.id;

        v_failed := v_failed + 1;
    end;
  end loop;

  return jsonb_build_object(
    'processed', v_processed,
    'sent', v_sent,
    'failed', v_failed
  );
end;
$$;

grant execute on function public.get_pending_scheduled_pickup_request(integer) to anon, authenticated;
grant execute on function public.create_scheduled_pickup_request(integer, jsonb, timestamptz, text) to anon, authenticated;
grant execute on function public.cancel_scheduled_pickup_request(uuid, integer) to anon, authenticated;
revoke execute on function public.scheduled_pickup_request_response(uuid) from public, anon, authenticated;
revoke execute on function public.process_due_scheduled_pickup_requests(integer) from public, anon, authenticated;
grant execute on function public.process_due_scheduled_pickup_requests(integer) to service_role;

alter table public.scheduled_pickup_requests enable row level security;

drop policy if exists scheduled_pickup_requests_select_admin on public.scheduled_pickup_requests;
drop policy if exists scheduled_pickup_requests_admin_all on public.scheduled_pickup_requests;

create policy scheduled_pickup_requests_select_admin on public.scheduled_pickup_requests
for select using (public.is_admin());

create policy scheduled_pickup_requests_admin_all on public.scheduled_pickup_requests
for all using (public.is_admin()) with check (public.is_admin());
