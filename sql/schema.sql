-- Carpool Dismissal System - Supabase Schema
-- Run in Supabase SQL Editor.

create extension if not exists "pgcrypto";

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'status_enum'
      and n.nspname = 'public'
  ) then
    create type public.status_enum as enum ('WAITING', 'CALLED');
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'app_role'
      and n.nspname = 'public'
  ) then
    create type public.app_role as enum ('admin', 'spotter');
  end if;
end
$$;

create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  carpool_number integer not null unique,
  parent_names text not null,
  contact_info text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  family_id uuid not null references public.families(id) on delete restrict,
  class_id uuid not null references public.classes(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.daily_status (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  date date not null,
  status public.status_enum not null,
  called_at timestamptz,
  called_by text,
  created_at timestamptz not null default now(),
  unique (student_id, date)
);

create table if not exists public.app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now()
);

create table if not exists public.pickup_authorizations (
  id uuid primary key default gen_random_uuid(),
  granting_family_id uuid not null references public.families(id) on delete restrict,
  receiving_family_id uuid not null references public.families(id) on delete restrict,
  starts_on date not null,
  ends_on date not null,
  is_revoked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by text,
  constraint pickup_authorizations_distinct_families check (granting_family_id <> receiving_family_id),
  constraint pickup_authorizations_valid_dates check (starts_on <= ends_on)
);

create table if not exists public.pickup_authorization_students (
  authorization_id uuid not null references public.pickup_authorizations(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  primary key (authorization_id, student_id)
);

create table if not exists public.pickup_authorization_audit (
  id uuid primary key default gen_random_uuid(),
  authorization_id uuid references public.pickup_authorizations(id) on delete set null,
  action text not null,
  actor_type text not null,
  granting_family_id uuid references public.families(id) on delete set null,
  receiving_family_id uuid references public.families(id) on delete set null,
  starts_on date,
  ends_on date,
  student_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);

create index if not exists idx_students_class_id on public.students(class_id);
create index if not exists idx_students_family_id on public.students(family_id);
create index if not exists idx_daily_status_date on public.daily_status(date);
create index if not exists idx_daily_status_student_date on public.daily_status(student_id, date);
create index if not exists idx_pickup_authorizations_receiver_dates
  on public.pickup_authorizations(receiving_family_id, starts_on, ends_on)
  where is_revoked = false;
create index if not exists idx_pickup_authorizations_granting_created
  on public.pickup_authorizations(granting_family_id, created_at desc);
create index if not exists idx_pickup_authorization_students_student_id
  on public.pickup_authorization_students(student_id);
create index if not exists idx_pickup_authorization_audit_created
  on public.pickup_authorization_audit(created_at desc);
create index if not exists idx_pickup_authorization_audit_granting_created
  on public.pickup_authorization_audit(granting_family_id, created_at desc);
create index if not exists idx_pickup_authorization_audit_receiving_created
  on public.pickup_authorization_audit(receiving_family_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_families_updated_at on public.families;
create trigger trg_families_updated_at
before update on public.families
for each row execute function public.set_updated_at();

drop trigger if exists trg_students_updated_at on public.students;
create trigger trg_students_updated_at
before update on public.students
for each row execute function public.set_updated_at();

drop trigger if exists trg_pickup_authorizations_updated_at on public.pickup_authorizations;
create trigger trg_pickup_authorizations_updated_at
before update on public.pickup_authorizations
for each row execute function public.set_updated_at();

create or replace function public.school_today()
returns date
language sql
stable
as $$
  select (now() at time zone 'America/New_York')::date;
$$;

grant execute on function public.school_today() to anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.app_users u
    where u.id = auth.uid() and u.role = 'admin'
  );
$$;

create or replace function public.is_spotter_or_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.app_users u
    where u.id = auth.uid() and u.role in ('spotter', 'admin')
  );
$$;

create or replace function public.family_id_for_carpool(p_carpool_number integer)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select f.id
  from public.families f
  where f.carpool_number = p_carpool_number
  limit 1;
$$;

create or replace function public.active_authorized_students_for_receiver(
  p_receiving_family_id uuid,
  p_on_date date
)
returns table(
  authorization_id uuid,
  granting_family_id uuid,
  granting_carpool_number integer,
  granting_parent_names text,
  starts_on date,
  ends_on date,
  student_id uuid,
  first_name text,
  last_name text,
  class_id uuid,
  class_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    pa.id,
    pa.granting_family_id,
    gf.carpool_number,
    gf.parent_names,
    pa.starts_on,
    pa.ends_on,
    s.id,
    s.first_name,
    s.last_name,
    s.class_id,
    c.name
  from public.pickup_authorizations pa
  join public.families gf on gf.id = pa.granting_family_id
  join public.pickup_authorization_students pas on pas.authorization_id = pa.id
  join public.students s on s.id = pas.student_id
  join public.classes c on c.id = s.class_id
  where pa.receiving_family_id = p_receiving_family_id
    and pa.is_revoked = false
    and p_on_date between pa.starts_on and pa.ends_on
  order by gf.carpool_number, s.last_name, s.first_name;
$$;

create or replace function public.write_pickup_authorization_audit(
  p_authorization_id uuid,
  p_action text,
  p_actor_type text,
  p_granting_family_id uuid,
  p_receiving_family_id uuid,
  p_starts_on date,
  p_ends_on date,
  p_student_ids uuid[],
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.pickup_authorization_audit (
    authorization_id,
    action,
    actor_type,
    granting_family_id,
    receiving_family_id,
    starts_on,
    ends_on,
    student_ids,
    details
  ) values (
    p_authorization_id,
    p_action,
    p_actor_type,
    p_granting_family_id,
    p_receiving_family_id,
    p_starts_on,
    p_ends_on,
    coalesce(p_student_ids, '{}'::uuid[]),
    coalesce(p_details, '{}'::jsonb)
  );
end;
$$;

create or replace function public.get_parent_checkin_context(p_carpool_number integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public.school_today();
  v_family record;
  v_own_students jsonb := '[]'::jsonb;
  v_authorized_pickups jsonb := '[]'::jsonb;
begin
  select f.id, f.carpool_number, f.parent_names
  into v_family
  from public.families f
  where f.carpool_number = p_carpool_number
  limit 1;

  if v_family.id is null then
    raise exception 'Carpool number not found';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'student_id', s.id,
        'first_name', s.first_name,
        'last_name', s.last_name,
        'class_name', c.name
      )
      order by s.last_name, s.first_name
    ),
    '[]'::jsonb
  )
  into v_own_students
  from public.students s
  join public.classes c on c.id = s.class_id
  where s.family_id = v_family.id;

  with active_rows as (
    select *
    from public.active_authorized_students_for_receiver(v_family.id, v_today)
  ),
  family_groups as (
    select
      ar.authorization_id,
      ar.granting_family_id,
      ar.granting_carpool_number,
      ar.granting_parent_names,
      ar.starts_on,
      ar.ends_on,
      jsonb_agg(
        jsonb_build_object(
          'student_id', ar.student_id,
          'first_name', ar.first_name,
          'last_name', ar.last_name,
          'class_name', ar.class_name
        )
        order by ar.last_name, ar.first_name
      ) as students
    from active_rows ar
    group by
      ar.authorization_id,
      ar.granting_family_id,
      ar.granting_carpool_number,
      ar.granting_parent_names,
      ar.starts_on,
      ar.ends_on
    order by ar.granting_carpool_number
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'authorization_id', fg.authorization_id,
        'family_id', fg.granting_family_id,
        'carpool_number', fg.granting_carpool_number,
        'parent_names', fg.granting_parent_names,
        'starts_on', fg.starts_on,
        'ends_on', fg.ends_on,
        'students', fg.students
      )
      order by fg.granting_carpool_number
    ),
    '[]'::jsonb
  )
  into v_authorized_pickups
  from family_groups fg;

  return jsonb_build_object(
    'requesting_family', jsonb_build_object(
      'family_id', v_family.id,
      'carpool_number', v_family.carpool_number,
      'parent_names', v_family.parent_names
    ),
    'own_students', v_own_students,
    'authorized_pickups', v_authorized_pickups
  );
end;
$$;

create or replace function public.submit_check_in_request(
  p_requesting_carpool_number integer,
  p_targets jsonb,
  p_called_by text
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
  v_called jsonb := '[]'::jsonb;
begin
  if p_called_by not in ('parent', 'spotter') then
    raise exception 'Invalid caller';
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
    select s.family_id, s.id as student_id
    from public.students s
    where s.family_id = v_requesting_family_id
    union
    select pa.granting_family_id, pas.student_id
    from public.pickup_authorizations pa
    join public.pickup_authorization_students pas on pas.authorization_id = pa.id
    where pa.receiving_family_id = v_requesting_family_id
      and pa.is_revoked = false
      and v_today between pa.starts_on and pa.ends_on
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

  with submitted_targets as (
    select distinct
      (item->>'family_id')::uuid as family_id,
      sid.student_id
    from jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) item
    cross join lateral (
      select jsonb_array_elements_text(item->'student_ids')::uuid as student_id
    ) sid
  ),
  selected_students as (
    select distinct
      st.family_id,
      st.student_id
    from submitted_targets st
  ),
  upserted as (
    insert into public.daily_status (student_id, date, status, called_at, called_by)
    select ss.student_id, v_today, 'CALLED', now(), p_called_by
    from selected_students ss
    on conflict (student_id, date)
    do update set
      status = excluded.status,
      called_at = excluded.called_at,
      called_by = excluded.called_by
    returning student_id
  ),
  response_rows as (
    select
      f.id as family_id,
      f.carpool_number,
      f.parent_names,
      s.id as student_id,
      s.first_name,
      s.last_name,
      c.name as class_name
    from public.students s
    join public.families f on f.id = s.family_id
    join public.classes c on c.id = s.class_id
    join upserted u on u.student_id = s.id
  ),
  grouped as (
    select
      rr.family_id,
      rr.carpool_number,
      rr.parent_names,
      jsonb_agg(
        jsonb_build_object(
          'student_id', rr.student_id,
          'first_name', rr.first_name,
          'last_name', rr.last_name,
          'class_name', rr.class_name
        )
        order by rr.last_name, rr.first_name
      ) as students
    from response_rows rr
    group by rr.family_id, rr.carpool_number, rr.parent_names
    order by rr.carpool_number
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'family_id', g.family_id,
        'carpool_number', g.carpool_number,
        'parent_names', g.parent_names,
        'students', g.students
      )
      order by g.carpool_number
    ),
    '[]'::jsonb
  )
  into v_called
  from grouped g;

  return jsonb_build_object(
    'called_by', p_called_by,
    'families', v_called
  );
end;
$$;

create or replace function public.get_family_authorizations(p_carpool_number integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public.school_today();
  v_family_id uuid;
  v_result jsonb := '[]'::jsonb;
begin
  v_family_id := public.family_id_for_carpool(p_carpool_number);
  if v_family_id is null then
    raise exception 'Carpool number not found';
  end if;

  with auth_rows as (
    select
      pa.id,
      pa.starts_on,
      pa.ends_on,
      pa.is_revoked,
      pa.created_at,
      pa.updated_at,
      pa.revoked_at,
      pa.revoked_by,
      rf.id as receiving_family_id,
      rf.carpool_number as receiving_carpool_number,
      rf.parent_names as receiving_parent_names,
      case
        when pa.is_revoked then 'Revoked'
        when v_today < pa.starts_on then 'Upcoming'
        when v_today > pa.ends_on then 'Expired'
        else 'Active'
      end as status_label
    from public.pickup_authorizations pa
    join public.families rf on rf.id = pa.receiving_family_id
    where pa.granting_family_id = v_family_id
  ),
  auth_with_students as (
    select
      ar.*,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'student_id', s.id,
            'first_name', s.first_name,
            'last_name', s.last_name,
            'class_name', c.name
          )
          order by s.last_name, s.first_name
        ) filter (where s.id is not null),
        '[]'::jsonb
      ) as students
    from auth_rows ar
    left join public.pickup_authorization_students pas on pas.authorization_id = ar.id
    left join public.students s on s.id = pas.student_id
    left join public.classes c on c.id = s.class_id
    group by
      ar.id,
      ar.starts_on,
      ar.ends_on,
      ar.is_revoked,
      ar.created_at,
      ar.updated_at,
      ar.revoked_at,
      ar.revoked_by,
      ar.receiving_family_id,
      ar.receiving_carpool_number,
      ar.receiving_parent_names,
      ar.status_label
    order by ar.created_at desc
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'authorization_id', aws.id,
        'starts_on', aws.starts_on,
        'ends_on', aws.ends_on,
        'is_revoked', aws.is_revoked,
        'status_label', aws.status_label,
        'created_at', aws.created_at,
        'updated_at', aws.updated_at,
        'revoked_at', aws.revoked_at,
        'revoked_by', aws.revoked_by,
        'receiving_family', jsonb_build_object(
          'family_id', aws.receiving_family_id,
          'carpool_number', aws.receiving_carpool_number,
          'parent_names', aws.receiving_parent_names
        ),
        'students', aws.students
      )
      order by aws.created_at desc
    ),
    '[]'::jsonb
  )
  into v_result
  from auth_with_students aws;

  return v_result;
end;
$$;

create or replace function public.create_pickup_authorization(
  p_granting_carpool_number integer,
  p_receiving_carpool_number integer,
  p_student_ids uuid[],
  p_starts_on date,
  p_ends_on date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_granting_family_id uuid;
  v_receiving_family_id uuid;
  v_authorization_id uuid;
  v_invalid_count integer;
begin
  if p_starts_on is null or p_ends_on is null or p_starts_on > p_ends_on then
    raise exception 'Invalid date range';
  end if;

  v_granting_family_id := public.family_id_for_carpool(p_granting_carpool_number);
  v_receiving_family_id := public.family_id_for_carpool(p_receiving_carpool_number);

  if v_granting_family_id is null or v_receiving_family_id is null then
    raise exception 'Carpool number not found';
  end if;

  if v_granting_family_id = v_receiving_family_id then
    raise exception 'Receiving family must be different';
  end if;

  if coalesce(array_length(p_student_ids, 1), 0) = 0 then
    raise exception 'Select at least one student';
  end if;

  select count(*)
  into v_invalid_count
  from unnest(p_student_ids) sid
  left join public.students s on s.id = sid and s.family_id = v_granting_family_id
  where s.id is null;

  if v_invalid_count > 0 then
    raise exception 'Selected students must belong to the granting family';
  end if;

  insert into public.pickup_authorizations (
    granting_family_id,
    receiving_family_id,
    starts_on,
    ends_on
  ) values (
    v_granting_family_id,
    v_receiving_family_id,
    p_starts_on,
    p_ends_on
  )
  returning id into v_authorization_id;

  insert into public.pickup_authorization_students (authorization_id, student_id)
  select v_authorization_id, sid
  from unnest(p_student_ids) sid;

  perform public.write_pickup_authorization_audit(
    v_authorization_id,
    'CREATED',
    'parent',
    v_granting_family_id,
    v_receiving_family_id,
    p_starts_on,
    p_ends_on,
    p_student_ids,
    jsonb_build_object(
      'granting_carpool_number', p_granting_carpool_number,
      'receiving_carpool_number', p_receiving_carpool_number
    )
  );

  return jsonb_build_object('authorization_id', v_authorization_id);
end;
$$;

create or replace function public.update_pickup_authorization(
  p_authorization_id uuid,
  p_granting_carpool_number integer,
  p_student_ids uuid[],
  p_starts_on date,
  p_ends_on date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_granting_family_id uuid;
  v_receiving_family_id uuid;
  v_is_revoked boolean;
  v_invalid_count integer;
begin
  if p_starts_on is null or p_ends_on is null or p_starts_on > p_ends_on then
    raise exception 'Invalid date range';
  end if;

  v_granting_family_id := public.family_id_for_carpool(p_granting_carpool_number);
  if v_granting_family_id is null then
    raise exception 'Carpool number not found';
  end if;

  select pa.receiving_family_id, pa.is_revoked
  into v_receiving_family_id, v_is_revoked
  from public.pickup_authorizations pa
  where pa.id = p_authorization_id
    and pa.granting_family_id = v_granting_family_id;

  if v_receiving_family_id is null then
    raise exception 'Authorization not found';
  end if;

  if v_is_revoked then
    raise exception 'Authorization has been revoked';
  end if;

  if coalesce(array_length(p_student_ids, 1), 0) = 0 then
    raise exception 'Select at least one student';
  end if;

  select count(*)
  into v_invalid_count
  from unnest(p_student_ids) sid
  left join public.students s on s.id = sid and s.family_id = v_granting_family_id
  where s.id is null;

  if v_invalid_count > 0 then
    raise exception 'Selected students must belong to the granting family';
  end if;

  update public.pickup_authorizations
  set starts_on = p_starts_on,
      ends_on = p_ends_on
  where id = p_authorization_id;

  delete from public.pickup_authorization_students
  where authorization_id = p_authorization_id;

  insert into public.pickup_authorization_students (authorization_id, student_id)
  select p_authorization_id, sid
  from unnest(p_student_ids) sid;

  perform public.write_pickup_authorization_audit(
    p_authorization_id,
    'UPDATED',
    'parent',
    v_granting_family_id,
    v_receiving_family_id,
    p_starts_on,
    p_ends_on,
    p_student_ids,
    jsonb_build_object(
      'granting_carpool_number', p_granting_carpool_number
    )
  );

  return jsonb_build_object('authorization_id', p_authorization_id);
end;
$$;

create or replace function public.revoke_pickup_authorization(
  p_authorization_id uuid,
  p_granting_carpool_number integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_granting_family_id uuid;
  v_receiving_family_id uuid;
  v_starts_on date;
  v_ends_on date;
  v_student_ids uuid[];
begin
  v_granting_family_id := public.family_id_for_carpool(p_granting_carpool_number);
  if v_granting_family_id is null then
    raise exception 'Carpool number not found';
  end if;

  select pa.receiving_family_id, pa.starts_on, pa.ends_on
  into v_receiving_family_id, v_starts_on, v_ends_on
  from public.pickup_authorizations pa
  where pa.id = p_authorization_id
    and pa.granting_family_id = v_granting_family_id
    and pa.is_revoked = false;

  if v_receiving_family_id is null then
    raise exception 'Authorization not found';
  end if;

  select coalesce(array_agg(pas.student_id order by pas.student_id), '{}'::uuid[])
  into v_student_ids
  from public.pickup_authorization_students pas
  where pas.authorization_id = p_authorization_id;

  update public.pickup_authorizations
  set is_revoked = true,
      revoked_at = now(),
      revoked_by = 'parent'
  where id = p_authorization_id;

  perform public.write_pickup_authorization_audit(
    p_authorization_id,
    'REVOKED',
    'parent',
    v_granting_family_id,
    v_receiving_family_id,
    v_starts_on,
    v_ends_on,
    v_student_ids,
    jsonb_build_object(
      'granting_carpool_number', p_granting_carpool_number
    )
  );

  return true;
end;
$$;

grant execute on function public.family_id_for_carpool(integer) to anon, authenticated;
grant execute on function public.active_authorized_students_for_receiver(uuid, date) to authenticated;
grant execute on function public.get_parent_checkin_context(integer) to anon, authenticated;
grant execute on function public.submit_check_in_request(integer, jsonb, text) to anon, authenticated;
grant execute on function public.get_family_authorizations(integer) to anon, authenticated;
grant execute on function public.create_pickup_authorization(integer, integer, uuid[], date, date) to anon, authenticated;
grant execute on function public.update_pickup_authorization(uuid, integer, uuid[], date, date) to anon, authenticated;
grant execute on function public.revoke_pickup_authorization(uuid, integer) to anon, authenticated;

alter table public.daily_status replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'daily_status'
  ) then
    alter publication supabase_realtime add table public.daily_status;
  end if;
end
$$;

alter table public.families enable row level security;
alter table public.classes enable row level security;
alter table public.students enable row level security;
alter table public.daily_status enable row level security;
alter table public.app_users enable row level security;
alter table public.pickup_authorizations enable row level security;
alter table public.pickup_authorization_students enable row level security;
alter table public.pickup_authorization_audit enable row level security;

drop policy if exists families_select_staff on public.families;
drop policy if exists families_admin_all on public.families;
drop policy if exists classes_select_public on public.classes;
drop policy if exists classes_admin_all on public.classes;
drop policy if exists students_select_public on public.students;
drop policy if exists students_admin_all on public.students;
drop policy if exists daily_status_select_public on public.daily_status;
drop policy if exists daily_status_write_staff on public.daily_status;
drop policy if exists daily_status_update_staff on public.daily_status;
drop policy if exists daily_status_delete_admin on public.daily_status;
drop policy if exists app_users_self_read on public.app_users;
drop policy if exists app_users_admin_all on public.app_users;
drop policy if exists pickup_authorizations_select_staff on public.pickup_authorizations;
drop policy if exists pickup_authorizations_admin_all on public.pickup_authorizations;
drop policy if exists pickup_authorization_students_select_staff on public.pickup_authorization_students;
drop policy if exists pickup_authorization_students_admin_all on public.pickup_authorization_students;
drop policy if exists pickup_authorization_audit_select_staff on public.pickup_authorization_audit;
drop policy if exists pickup_authorization_audit_admin_all on public.pickup_authorization_audit;

-- families: only spotter/admin can read; only admin can mutate
create policy families_select_staff on public.families
for select using (public.is_spotter_or_admin());

create policy families_admin_all on public.families
for all using (public.is_admin()) with check (public.is_admin());

-- classes/students: anon read for classroom displays; staff/admin full based on role
create policy classes_select_public on public.classes
for select using (true);

create policy classes_admin_all on public.classes
for all using (public.is_admin()) with check (public.is_admin());

create policy students_select_public on public.students
for select using (true);

create policy students_admin_all on public.students
for all using (public.is_admin()) with check (public.is_admin());

-- daily_status: anon read for realtime classroom views; spotter/admin can write
create policy daily_status_select_public on public.daily_status
for select using (true);

create policy daily_status_write_staff on public.daily_status
for insert with check (public.is_spotter_or_admin());

create policy daily_status_update_staff on public.daily_status
for update using (public.is_spotter_or_admin()) with check (public.is_spotter_or_admin());

create policy daily_status_delete_admin on public.daily_status
for delete using (public.is_admin());

-- app_users visibility
create policy app_users_self_read on public.app_users
for select using (id = auth.uid());

create policy app_users_admin_all on public.app_users
for all using (public.is_admin()) with check (public.is_admin());

create policy pickup_authorizations_select_staff on public.pickup_authorizations
for select using (public.is_spotter_or_admin());

create policy pickup_authorizations_admin_all on public.pickup_authorizations
for all using (public.is_admin()) with check (public.is_admin());

create policy pickup_authorization_students_select_staff on public.pickup_authorization_students
for select using (public.is_spotter_or_admin());

create policy pickup_authorization_students_admin_all on public.pickup_authorization_students
for all using (public.is_admin()) with check (public.is_admin());

create policy pickup_authorization_audit_select_staff on public.pickup_authorization_audit
for select using (public.is_spotter_or_admin());

create policy pickup_authorization_audit_admin_all on public.pickup_authorization_audit
for all using (public.is_admin()) with check (public.is_admin());
