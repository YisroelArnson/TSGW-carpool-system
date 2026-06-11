-- Password-gate parent and classroom access with Supabase Auth sessions.

alter table public.app_users
  add column if not exists family_id uuid references public.families(id) on delete set null;

create unique index if not exists app_users_parent_family_unique
  on public.app_users(family_id)
  where role = 'parent'::public.app_role and family_id is not null;

create unique index if not exists app_users_one_classroom_unique
  on public.app_users((role))
  where role = 'classroom'::public.app_role;

create or replace function public.current_family_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select u.family_id
  from public.app_users u
  where u.id = auth.uid()
    and u.role = 'parent'
  limit 1;
$$;

create or replace function public.current_carpool_number()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select f.carpool_number
  from public.families f
  where f.id = public.current_family_id()
  limit 1;
$$;

create or replace function public.is_parent()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_family_id() is not null;
$$;

create or replace function public.is_parent_for_family(p_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_family_id is not null
    and public.current_family_id() is not null
    and public.current_family_id() = p_family_id;
$$;

create or replace function public.is_classroom_or_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.app_users u
    where u.id = auth.uid()
      and u.role in ('classroom', 'spotter', 'admin')
  );
$$;

create or replace function public.require_current_parent_carpool_number()
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_carpool_number integer;
begin
  v_carpool_number := public.current_carpool_number();
  if v_carpool_number is null then
    raise exception 'Parent authentication required';
  end if;

  return v_carpool_number;
end;
$$;

create or replace function public.is_parent_allowed_student(
  p_student_id uuid,
  p_on_date date
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.allowed_students_for_family(public.current_family_id(), p_on_date) allowed
    where allowed.student_id = p_student_id
  );
$$;

create or replace function public.get_parent_checkin_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return public.get_parent_checkin_context(public.require_current_parent_carpool_number());
end;
$$;

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

  return public.get_parent_checkin_context(p_carpool_number);
end;
$$;

create or replace function public.submit_parent_check_in_request(
  p_targets jsonb,
  p_checked_in_by text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.submit_check_in_request(
    public.require_current_parent_carpool_number(),
    p_targets,
    'parent',
    p_checked_in_by
  );
end;
$$;

create or replace function public.staff_submit_check_in_request(
  p_requesting_carpool_number integer,
  p_targets jsonb,
  p_checked_in_by text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_spotter_or_admin() then
    raise exception 'Staff authentication required';
  end if;

  return public.submit_check_in_request(
    p_requesting_carpool_number,
    p_targets,
    'spotter',
    p_checked_in_by
  );
end;
$$;

create or replace function public.submit_parent_carpool_preset_check_in(
  p_preset_id uuid,
  p_checked_in_by text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.submit_carpool_preset_check_in(
    p_preset_id,
    public.require_current_parent_carpool_number(),
    'parent',
    p_checked_in_by
  );
end;
$$;

create or replace function public.get_pending_parent_scheduled_pickup_request()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return public.get_pending_scheduled_pickup_request(public.require_current_parent_carpool_number());
end;
$$;

create or replace function public.create_parent_scheduled_pickup_request(
  p_targets jsonb,
  p_send_at timestamptz,
  p_checked_in_by text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.create_scheduled_pickup_request(
    public.require_current_parent_carpool_number(),
    p_targets,
    p_send_at,
    p_checked_in_by
  );
end;
$$;

create or replace function public.cancel_parent_scheduled_pickup_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.cancel_scheduled_pickup_request(
    p_request_id,
    public.require_current_parent_carpool_number()
  );
end;
$$;

create or replace function public.cancel_parent_check_in_request(p_student_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.cancel_parent_check_in_request(
    public.require_current_parent_carpool_number(),
    p_student_ids
  );
end;
$$;

create or replace function public.get_family_authorizations()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return public.get_family_authorizations(public.require_current_parent_carpool_number());
end;
$$;

create or replace function public.search_receiving_families(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return public.search_receiving_families(
    public.require_current_parent_carpool_number(),
    p_query
  );
end;
$$;

create or replace function public.create_parent_pickup_authorization(
  p_receiving_family_id uuid,
  p_student_ids uuid[],
  p_starts_on date,
  p_ends_on date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.create_pickup_authorization_for_family(
    public.require_current_parent_carpool_number(),
    p_receiving_family_id,
    p_student_ids,
    p_starts_on,
    p_ends_on
  );
end;
$$;

create or replace function public.update_parent_pickup_authorization(
  p_authorization_id uuid,
  p_student_ids uuid[],
  p_starts_on date,
  p_ends_on date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.update_pickup_authorization(
    p_authorization_id,
    public.require_current_parent_carpool_number(),
    p_student_ids,
    p_starts_on,
    p_ends_on
  );
end;
$$;

create or replace function public.revoke_parent_pickup_authorization(p_authorization_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.revoke_pickup_authorization(
    p_authorization_id,
    public.require_current_parent_carpool_number()
  );
end;
$$;

create or replace function public.create_parent_carpool_preset(
  p_name text,
  p_student_ids uuid[],
  p_weekdays text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.create_carpool_preset(
    public.require_current_parent_carpool_number(),
    p_name,
    p_student_ids,
    p_weekdays
  );
end;
$$;

create or replace function public.update_parent_carpool_preset(
  p_preset_id uuid,
  p_name text,
  p_student_ids uuid[],
  p_weekdays text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.update_carpool_preset(
    p_preset_id,
    public.require_current_parent_carpool_number(),
    p_name,
    p_student_ids,
    p_weekdays
  );
end;
$$;

create or replace function public.delete_parent_carpool_preset(p_preset_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.delete_carpool_preset(
    p_preset_id,
    public.require_current_parent_carpool_number()
  );
end;
$$;

revoke execute on function public.family_id_for_carpool(integer) from public, anon, authenticated;
revoke execute on function public.allowed_students_for_family(uuid, date) from public, anon, authenticated;
revoke execute on function public.active_authorized_students_for_receiver(uuid, date) from public, anon, authenticated;
revoke execute on function public.prune_invalid_carpool_preset_students(uuid, date) from public, anon, authenticated;

revoke execute on function public.get_parent_checkin_context(integer) from public, anon, authenticated;
revoke execute on function public.submit_check_in_request(integer, jsonb, text, text) from public, anon, authenticated;
revoke execute on function public.cancel_parent_check_in_request(integer, uuid[]) from public, anon, authenticated;
revoke execute on function public.get_pending_scheduled_pickup_request(integer) from public, anon, authenticated;
revoke execute on function public.create_scheduled_pickup_request(integer, jsonb, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.cancel_scheduled_pickup_request(uuid, integer) from public, anon, authenticated;
revoke execute on function public.get_family_authorizations(integer) from public, anon, authenticated;
revoke execute on function public.search_receiving_families(integer, text) from public, anon, authenticated;
revoke execute on function public.create_pickup_authorization_for_family(integer, uuid, uuid[], date, date) from public, anon, authenticated;
revoke execute on function public.create_pickup_authorization(integer, integer, uuid[], date, date) from public, anon, authenticated;
revoke execute on function public.update_pickup_authorization(uuid, integer, uuid[], date, date) from public, anon, authenticated;
revoke execute on function public.revoke_pickup_authorization(uuid, integer) from public, anon, authenticated;
revoke execute on function public.create_carpool_preset(integer, text, uuid[], text[]) from public, anon, authenticated;
revoke execute on function public.update_carpool_preset(uuid, integer, text, uuid[], text[]) from public, anon, authenticated;
revoke execute on function public.delete_carpool_preset(uuid, integer) from public, anon, authenticated;
revoke execute on function public.submit_carpool_preset_check_in(uuid, integer, text, text) from public, anon, authenticated;
revoke execute on function public.get_pickup_geofence_settings() from public, anon;

revoke execute on function public.get_parent_checkin_context() from public, anon;
revoke execute on function public.staff_get_parent_checkin_context(integer) from public, anon;
revoke execute on function public.submit_parent_check_in_request(jsonb, text) from public, anon;
revoke execute on function public.staff_submit_check_in_request(integer, jsonb, text) from public, anon;
revoke execute on function public.submit_parent_carpool_preset_check_in(uuid, text) from public, anon;
revoke execute on function public.get_pending_parent_scheduled_pickup_request() from public, anon;
revoke execute on function public.create_parent_scheduled_pickup_request(jsonb, timestamptz, text) from public, anon;
revoke execute on function public.cancel_parent_scheduled_pickup_request(uuid) from public, anon;
revoke execute on function public.cancel_parent_check_in_request(uuid[]) from public, anon;
revoke execute on function public.get_family_authorizations() from public, anon;
revoke execute on function public.search_receiving_families(text) from public, anon;
revoke execute on function public.create_parent_pickup_authorization(uuid, uuid[], date, date) from public, anon;
revoke execute on function public.update_parent_pickup_authorization(uuid, uuid[], date, date) from public, anon;
revoke execute on function public.revoke_parent_pickup_authorization(uuid) from public, anon;
revoke execute on function public.create_parent_carpool_preset(text, uuid[], text[]) from public, anon;
revoke execute on function public.update_parent_carpool_preset(uuid, text, uuid[], text[]) from public, anon;
revoke execute on function public.delete_parent_carpool_preset(uuid) from public, anon;
revoke execute on function public.is_parent_allowed_student(uuid, date) from public, anon;

grant execute on function public.get_parent_checkin_context() to authenticated;
grant execute on function public.staff_get_parent_checkin_context(integer) to authenticated;
grant execute on function public.submit_parent_check_in_request(jsonb, text) to authenticated;
grant execute on function public.staff_submit_check_in_request(integer, jsonb, text) to authenticated;
grant execute on function public.submit_parent_carpool_preset_check_in(uuid, text) to authenticated;
grant execute on function public.get_pending_parent_scheduled_pickup_request() to authenticated;
grant execute on function public.create_parent_scheduled_pickup_request(jsonb, timestamptz, text) to authenticated;
grant execute on function public.cancel_parent_scheduled_pickup_request(uuid) to authenticated;
grant execute on function public.cancel_parent_check_in_request(uuid[]) to authenticated;
grant execute on function public.get_family_authorizations() to authenticated;
grant execute on function public.search_receiving_families(text) to authenticated;
grant execute on function public.create_parent_pickup_authorization(uuid, uuid[], date, date) to authenticated;
grant execute on function public.update_parent_pickup_authorization(uuid, uuid[], date, date) to authenticated;
grant execute on function public.revoke_parent_pickup_authorization(uuid) to authenticated;
grant execute on function public.create_parent_carpool_preset(text, uuid[], text[]) to authenticated;
grant execute on function public.update_parent_carpool_preset(uuid, text, uuid[], text[]) to authenticated;
grant execute on function public.delete_parent_carpool_preset(uuid) to authenticated;
grant execute on function public.get_pickup_geofence_settings() to authenticated;
grant execute on function public.is_parent_allowed_student(uuid, date) to authenticated;

grant execute on function public.submit_check_in_request(integer, jsonb, text, text) to service_role;
grant execute on function public.get_pending_scheduled_pickup_request(integer) to service_role;
grant execute on function public.create_scheduled_pickup_request(integer, jsonb, timestamptz, text) to service_role;
grant execute on function public.cancel_scheduled_pickup_request(uuid, integer) to service_role;

drop policy if exists classes_select_public on public.classes;
drop policy if exists classes_select_authorized on public.classes;
create policy classes_select_authorized on public.classes
for select using (public.is_classroom_or_staff());

drop policy if exists students_select_public on public.students;
drop policy if exists students_select_authorized on public.students;
create policy students_select_authorized on public.students
for select using (public.is_classroom_or_staff());

drop policy if exists daily_status_select_public on public.daily_status;
drop policy if exists daily_status_select_authorized on public.daily_status;
create policy daily_status_select_authorized on public.daily_status
for select using (
  public.is_classroom_or_staff()
  or (
    date = public.school_today()
    and public.is_parent_allowed_student(student_id, date)
  )
);

update storage.buckets
set public = false
where id = 'student-call-audio';

drop policy if exists student_call_audio_select_public on storage.objects;
drop policy if exists student_call_audio_select_authorized on storage.objects;
create policy student_call_audio_select_authorized on storage.objects
for select using (
  bucket_id = 'student-call-audio'
  and public.is_classroom_or_staff()
);
