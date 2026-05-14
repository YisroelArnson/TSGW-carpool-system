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
  parent_one_title text,
  parent_one_first_name text,
  parent_one_last_name text,
  parent_two_title text,
  parent_two_first_name text,
  parent_two_last_name text,
  contact_info text,
  notification_email text,
  notification_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.families
  add column if not exists parent_one_title text,
  add column if not exists parent_one_first_name text,
  add column if not exists parent_one_last_name text,
  add column if not exists parent_two_title text,
  add column if not exists parent_two_first_name text,
  add column if not exists parent_two_last_name text,
  add column if not exists notification_email text,
  add column if not exists notification_enabled boolean not null default true;

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
  call_audio_path text,
  call_audio_mime_type text,
  call_audio_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.students
  add column if not exists call_audio_path text,
  add column if not exists call_audio_mime_type text,
  add column if not exists call_audio_updated_at timestamptz;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'student-call-audio',
  'student-call-audio',
  true,
  2097152,
  array['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.daily_status (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  date date not null,
  status public.status_enum not null,
  called_at timestamptz,
  called_by text,
  checked_in_by text,
  pickup_family_id uuid references public.families(id) on delete set null,
  pickup_family_label text,
  created_at timestamptz not null default now(),
  unique (student_id, date)
);

alter table public.daily_status
  add column if not exists checked_in_by text,
  add column if not exists pickup_family_id uuid references public.families(id) on delete set null,
  add column if not exists pickup_family_label text;

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

create table if not exists public.pickup_notification_queue (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.pickup_authorization_audit(id) on delete cascade,
  authorization_id uuid references public.pickup_authorizations(id) on delete set null,
  action text not null,
  granting_family_id uuid references public.families(id) on delete set null,
  receiving_family_id uuid references public.families(id) on delete set null,
  starts_on date,
  ends_on date,
  student_ids uuid[] not null default '{}'::uuid[],
  status text not null default 'pending',
  attempt_count integer not null default 0,
  provider_message_id text,
  last_attempt_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pickup_notification_queue_status_check
    check (status in ('pending', 'processing', 'sent', 'skipped', 'failed')),
  constraint pickup_notification_queue_audit_unique unique (audit_id)
);

create table if not exists public.carpool_presets (
  id uuid primary key default gen_random_uuid(),
  owner_family_id uuid not null references public.families(id) on delete cascade,
  name text not null,
  weekdays text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.carpool_presets
  add column if not exists weekdays text[] not null default '{}'::text[];

create table if not exists public.carpool_preset_students (
  preset_id uuid not null references public.carpool_presets(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  primary key (preset_id, student_id)
);

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
create index if not exists idx_pickup_notification_queue_status_created
  on public.pickup_notification_queue(status, created_at);
create index if not exists idx_pickup_notification_queue_receiving_created
  on public.pickup_notification_queue(receiving_family_id, created_at desc);
create index if not exists idx_carpool_presets_owner_created
  on public.carpool_presets(owner_family_id, created_at desc);
create unique index if not exists idx_carpool_presets_owner_name_ci
  on public.carpool_presets(owner_family_id, lower(name));
create index if not exists idx_carpool_preset_students_student_id
  on public.carpool_preset_students(student_id);
create index if not exists idx_scheduled_pickup_requests_status_send_at
  on public.scheduled_pickup_requests(status, send_at);
create index if not exists idx_scheduled_pickup_requests_family_created
  on public.scheduled_pickup_requests(requesting_family_id, created_at desc);
create unique index if not exists idx_scheduled_pickup_requests_one_pending_family
  on public.scheduled_pickup_requests(requesting_family_id)
  where status = 'pending';

create or replace function public.family_display_name(
  p_parent_names text,
  p_parent_one_title text,
  p_parent_one_first_name text,
  p_parent_one_last_name text,
  p_parent_two_title text,
  p_parent_two_first_name text,
  p_parent_two_last_name text
)
returns text
language sql
immutable
as $$
  with parts as (
    select
      nullif(btrim(concat_ws(' ', nullif(btrim(p_parent_one_first_name), ''), nullif(btrim(p_parent_one_last_name), ''))), '') as parent_one_name,
      nullif(btrim(concat_ws(' ', nullif(btrim(p_parent_two_first_name), ''), nullif(btrim(p_parent_two_last_name), ''))), '') as parent_two_name,
      nullif(btrim(p_parent_names), '') as legacy_name
  )
  select coalesce(
    case
      when parent_one_name is not null and parent_two_name is not null then parent_one_name || ' & ' || parent_two_name
      when parent_one_name is not null then parent_one_name
      when parent_two_name is not null then parent_two_name
      else legacy_name
    end,
    'Family'
  )
  from parts;
$$;

create or replace function public.pickup_family_label(p_family_id uuid)
returns text
language sql
stable
as $$
  with family as (
    select
      nullif(btrim(parent_one_last_name), '') as parent_one_last,
      nullif(btrim(parent_two_last_name), '') as parent_two_last,
      public.family_display_name(
        parent_names,
        parent_one_title,
        parent_one_first_name,
        parent_one_last_name,
        parent_two_title,
        parent_two_first_name,
        parent_two_last_name
      ) as display_name
    from public.families
    where id = p_family_id
  ),
  labeled as (
    select
      parent_one_last,
      parent_two_last,
      nullif((regexp_match(display_name, '([[:alnum:]''-]+)[[:space:]]*$'))[1], '') as fallback_last
    from family
  )
  select coalesce(
    case
      when parent_one_last is not null
        and parent_two_last is not null
        and lower(parent_one_last) = lower(parent_two_last)
        then parent_one_last
      when parent_one_last is not null
        and parent_two_last is not null
        then parent_one_last || ' / ' || parent_two_last
      when parent_one_last is not null then parent_one_last
      when parent_two_last is not null then parent_two_last
      else fallback_last
    end,
    'Family'
  )
  from labeled;
$$;

create or replace function public.family_search_text(
  p_parent_names text,
  p_parent_one_title text,
  p_parent_one_first_name text,
  p_parent_one_last_name text,
  p_parent_two_title text,
  p_parent_two_first_name text,
  p_parent_two_last_name text
)
returns text
language sql
immutable
as $$
  select btrim(
    concat_ws(
      ' ',
      nullif(btrim(p_parent_names), ''),
      nullif(btrim(p_parent_one_title), ''),
      nullif(btrim(p_parent_one_first_name), ''),
      nullif(btrim(p_parent_one_last_name), ''),
      nullif(btrim(p_parent_two_title), ''),
      nullif(btrim(p_parent_two_first_name), ''),
      nullif(btrim(p_parent_two_last_name), ''),
      public.family_display_name(
        p_parent_names,
        p_parent_one_title,
        p_parent_one_first_name,
        p_parent_one_last_name,
        p_parent_two_title,
        p_parent_two_first_name,
        p_parent_two_last_name
      )
    )
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.sync_family_parent_names()
returns trigger
language plpgsql
as $$
begin
  new.parent_names := public.family_display_name(
    new.parent_names,
    new.parent_one_title,
    new.parent_one_first_name,
    new.parent_one_last_name,
    new.parent_two_title,
    new.parent_two_first_name,
    new.parent_two_last_name
  );
  return new;
end;
$$;

drop trigger if exists trg_families_updated_at on public.families;
create trigger trg_families_updated_at
before update on public.families
for each row execute function public.set_updated_at();

drop trigger if exists trg_families_sync_parent_names on public.families;
create trigger trg_families_sync_parent_names
before insert or update on public.families
for each row execute function public.sync_family_parent_names();

drop trigger if exists trg_students_updated_at on public.students;
create trigger trg_students_updated_at
before update on public.students
for each row execute function public.set_updated_at();

drop trigger if exists trg_pickup_authorizations_updated_at on public.pickup_authorizations;
create trigger trg_pickup_authorizations_updated_at
before update on public.pickup_authorizations
for each row execute function public.set_updated_at();

drop trigger if exists trg_pickup_notification_queue_updated_at on public.pickup_notification_queue;
create trigger trg_pickup_notification_queue_updated_at
before update on public.pickup_notification_queue
for each row execute function public.set_updated_at();

drop trigger if exists trg_carpool_presets_updated_at on public.carpool_presets;
create trigger trg_carpool_presets_updated_at
before update on public.carpool_presets
for each row execute function public.set_updated_at();

drop trigger if exists trg_scheduled_pickup_requests_updated_at on public.scheduled_pickup_requests;
create trigger trg_scheduled_pickup_requests_updated_at
before update on public.scheduled_pickup_requests
for each row execute function public.set_updated_at();

create or replace function public.school_today()
returns date
language sql
stable
as $$
  select (now() at time zone 'America/New_York')::date;
$$;

grant execute on function public.school_today() to anon, authenticated;

create or replace function public.normalize_carpool_preset_weekdays(p_weekdays text[])
returns text[]
language sql
immutable
as $$
  with allowed(day_name, sort_order) as (
    values
      ('sunday', 1),
      ('monday', 2),
      ('tuesday', 3),
      ('wednesday', 4),
      ('thursday', 5),
      ('friday', 6)
  ),
  submitted as (
    select distinct lower(btrim(day_name)) as day_name
    from unnest(coalesce(p_weekdays, '{}'::text[])) as days(day_name)
  )
  select coalesce(array_agg(a.day_name order by a.sort_order), '{}'::text[])
  from allowed a
  join submitted s on s.day_name = a.day_name;
$$;

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

create or replace function public.allowed_students_for_family(
  p_owner_family_id uuid,
  p_on_date date
)
returns table(
  family_id uuid,
  student_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select s.family_id, s.id
  from public.students s
  where s.family_id = p_owner_family_id
  union
  select pa.granting_family_id, pas.student_id
  from public.pickup_authorizations pa
  join public.pickup_authorization_students pas on pas.authorization_id = pa.id
  where pa.receiving_family_id = p_owner_family_id
    and pa.is_revoked = false
    and p_on_date between pa.starts_on and pa.ends_on;
$$;

create or replace function public.parent_reping_cooldown_students(
  p_called_by text,
  p_student_ids uuid[],
  p_on_date date
)
returns table(
  student_id uuid,
  retry_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    ds.student_id,
    ds.called_at + interval '3 minutes' as retry_at
  from public.daily_status ds
  where p_called_by = 'parent'
    and ds.date = p_on_date
    and ds.status = 'CALLED'
    and ds.student_id = any(coalesce(p_student_ids, '{}'::uuid[]))
    and ds.called_at is not null
    and ds.called_at > now() - interval '3 minutes';
$$;

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

drop function if exists public.active_authorized_students_for_receiver(uuid, date);

create function public.active_authorized_students_for_receiver(
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
declare
  v_audit_id uuid;
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
  )
  returning id into v_audit_id;

  if p_action in ('CREATED', 'UPDATED', 'REVOKED') then
    insert into public.pickup_notification_queue (
      audit_id,
      authorization_id,
      action,
      granting_family_id,
      receiving_family_id,
      starts_on,
      ends_on,
      student_ids
    ) values (
      v_audit_id,
      p_authorization_id,
      p_action,
      p_granting_family_id,
      p_receiving_family_id,
      p_starts_on,
      p_ends_on,
      coalesce(p_student_ids, '{}'::uuid[])
    )
    on conflict (audit_id) do nothing;
  end if;
end;
$$;

create or replace function public.prune_invalid_carpool_preset_students(
  p_owner_family_id uuid,
  p_on_date date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.carpool_preset_students cps
  using public.carpool_presets cp
  where cp.id = cps.preset_id
    and cp.owner_family_id = p_owner_family_id
    and not exists (
      select 1
      from public.allowed_students_for_family(p_owner_family_id, p_on_date) allowed
      where allowed.student_id = cps.student_id
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
  v_saved_carpools jsonb := '[]'::jsonb;
  v_scheduled_pickup jsonb := null;
begin
  select
    f.id,
    f.carpool_number,
    public.family_display_name(
      f.parent_names,
      f.parent_one_title,
      f.parent_one_first_name,
      f.parent_one_last_name,
      f.parent_two_title,
      f.parent_two_first_name,
      f.parent_two_last_name
    ) as display_name,
    f.parent_one_title,
    f.parent_one_first_name,
    f.parent_one_last_name,
    f.parent_two_title,
    f.parent_two_first_name,
    f.parent_two_last_name
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
        'class_name', c.name,
        'is_checked_in', coalesce(ds.status = 'CALLED', false),
        'called_at', ds.called_at,
        'called_by', ds.called_by,
        'retry_at', case
          when ds.status = 'CALLED' and ds.called_at is not null then ds.called_at + interval '3 minutes'
          else null
        end
      )
      order by s.last_name, s.first_name
    ),
    '[]'::jsonb
  )
  into v_own_students
  from public.students s
  join public.classes c on c.id = s.class_id
  left join public.daily_status ds
    on ds.student_id = s.id
   and ds.date = v_today
  where s.family_id = v_family.id;

  with active_rows as (
    select *
    from public.active_authorized_students_for_receiver(v_family.id, v_today)
  ),
  family_groups as (
    select
      ar.authorization_id,
      ar.granting_family_id,
      public.family_display_name(
        gf.parent_names,
        gf.parent_one_title,
        gf.parent_one_first_name,
        gf.parent_one_last_name,
        gf.parent_two_title,
        gf.parent_two_first_name,
        gf.parent_two_last_name
      ) as granting_display_name,
      gf.parent_one_title as granting_parent_one_title,
      gf.parent_one_first_name as granting_parent_one_first_name,
      gf.parent_one_last_name as granting_parent_one_last_name,
      gf.parent_two_title as granting_parent_two_title,
      gf.parent_two_first_name as granting_parent_two_first_name,
      gf.parent_two_last_name as granting_parent_two_last_name,
      ar.starts_on,
      ar.ends_on,
      jsonb_agg(
        jsonb_build_object(
          'student_id', ar.student_id,
          'first_name', ar.first_name,
          'last_name', ar.last_name,
          'class_name', ar.class_name,
          'is_checked_in', coalesce(ds.status = 'CALLED', false),
          'called_at', ds.called_at,
          'called_by', ds.called_by,
          'retry_at', case
            when ds.status = 'CALLED' and ds.called_at is not null then ds.called_at + interval '3 minutes'
            else null
          end
        )
        order by ar.last_name, ar.first_name
      ) as students
    from active_rows ar
    join public.families gf on gf.id = ar.granting_family_id
    left join public.daily_status ds
      on ds.student_id = ar.student_id
     and ds.date = v_today
    group by
      ar.authorization_id,
      ar.granting_family_id,
      gf.parent_names,
      gf.parent_one_title,
      gf.parent_one_first_name,
      gf.parent_one_last_name,
      gf.parent_two_title,
      gf.parent_two_first_name,
      gf.parent_two_last_name,
      ar.starts_on,
      ar.ends_on
    order by lower(public.family_display_name(
      gf.parent_names,
      gf.parent_one_title,
      gf.parent_one_first_name,
      gf.parent_one_last_name,
      gf.parent_two_title,
      gf.parent_two_first_name,
      gf.parent_two_last_name
    )), ar.authorization_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'authorization_id', fg.authorization_id,
        'family_id', fg.granting_family_id,
        'display_name', fg.granting_display_name,
        'parent_one_title', fg.granting_parent_one_title,
        'parent_one_first_name', fg.granting_parent_one_first_name,
        'parent_one_last_name', fg.granting_parent_one_last_name,
        'parent_two_title', fg.granting_parent_two_title,
        'parent_two_first_name', fg.granting_parent_two_first_name,
        'parent_two_last_name', fg.granting_parent_two_last_name,
        'starts_on', fg.starts_on,
        'ends_on', fg.ends_on,
        'students', fg.students
      )
      order by lower(fg.granting_display_name), fg.authorization_id
    ),
    '[]'::jsonb
  )
  into v_authorized_pickups
  from family_groups fg;

  perform public.prune_invalid_carpool_preset_students(v_family.id, v_today);

  with preset_rows as (
    select
      cp.id as preset_id,
      cp.name,
      cp.weekdays,
      s.family_id,
      public.family_display_name(
        f.parent_names,
        f.parent_one_title,
        f.parent_one_first_name,
        f.parent_one_last_name,
        f.parent_two_title,
        f.parent_two_first_name,
        f.parent_two_last_name
      ) as display_name,
      f.parent_one_title,
      f.parent_one_first_name,
      f.parent_one_last_name,
      f.parent_two_title,
      f.parent_two_first_name,
      f.parent_two_last_name,
      s.id as student_id,
      s.first_name,
      s.last_name,
      c.name as class_name
    from public.carpool_presets cp
    left join public.carpool_preset_students cps on cps.preset_id = cp.id
    left join public.students s on s.id = cps.student_id
    left join public.families f on f.id = s.family_id
    left join public.classes c on c.id = s.class_id
    where cp.owner_family_id = v_family.id
  ),
  grouped as (
    select
      pr.preset_id,
      pr.name,
      pr.weekdays,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'student_id', pr.student_id,
            'family_id', pr.family_id,
            'display_name', pr.display_name,
            'parent_one_title', pr.parent_one_title,
            'parent_one_first_name', pr.parent_one_first_name,
            'parent_one_last_name', pr.parent_one_last_name,
            'parent_two_title', pr.parent_two_title,
            'parent_two_first_name', pr.parent_two_first_name,
            'parent_two_last_name', pr.parent_two_last_name,
            'first_name', pr.first_name,
            'last_name', pr.last_name,
            'class_name', pr.class_name
          )
          order by pr.last_name, pr.first_name
        ) filter (where pr.student_id is not null),
        '[]'::jsonb
      ) as students,
      count(pr.student_id) as student_count
    from preset_rows pr
    group by pr.preset_id, pr.name, pr.weekdays
    order by lower(pr.name), pr.preset_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'preset_id', g.preset_id,
        'name', g.name,
        'weekdays', to_jsonb(g.weekdays),
        'students', g.students,
        'student_count', g.student_count
      )
      order by lower(g.name), g.preset_id
    ),
    '[]'::jsonb
  )
  into v_saved_carpools
  from grouped g;

  select jsonb_build_object(
    'request_id', spr.id,
    'status', spr.status,
    'send_at', spr.send_at,
    'target_count', spr.target_count,
    'targets', spr.targets,
    'created_at', spr.created_at
  )
  into v_scheduled_pickup
  from public.scheduled_pickup_requests spr
  where spr.requesting_family_id = v_family.id
    and spr.status = 'pending'
  order by spr.send_at
  limit 1;

  return jsonb_build_object(
    'requesting_family', jsonb_build_object(
      'family_id', v_family.id,
      'carpool_number', v_family.carpool_number,
      'display_name', v_family.display_name,
      'parent_one_title', v_family.parent_one_title,
      'parent_one_first_name', v_family.parent_one_first_name,
      'parent_one_last_name', v_family.parent_one_last_name,
      'parent_two_title', v_family.parent_two_title,
      'parent_two_first_name', v_family.parent_two_first_name,
      'parent_two_last_name', v_family.parent_two_last_name
    ),
    'own_students', v_own_students,
    'authorized_pickups', v_authorized_pickups,
    'saved_carpools', v_saved_carpools,
    'scheduled_pickup', v_scheduled_pickup
  );
end;
$$;

create or replace function public.submit_check_in_request(
  p_requesting_carpool_number integer,
  p_targets jsonb,
  p_called_by text,
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
  v_called jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_checked_in_by text := nullif(btrim(p_checked_in_by), '');
begin
  if p_called_by not in ('parent', 'spotter') then
    raise exception 'Invalid caller';
  end if;

  if p_called_by = 'spotter' and not public.is_spotter_or_admin() then
    raise exception 'Spotter authentication required';
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
  cooldown_students as (
    select cds.student_id, cds.retry_at
    from public.parent_reping_cooldown_students(
      p_called_by,
      coalesce((select array_agg(ss.student_id) from selected_students ss), '{}'::uuid[]),
      v_today
    ) cds
  ),
  eligible_students as (
    select ss.family_id, ss.student_id
    from selected_students ss
    left join cooldown_students cds on cds.student_id = ss.student_id
    where cds.student_id is null
  ),
  upserted as (
    insert into public.daily_status (
      student_id,
      date,
      status,
      called_at,
      called_by,
      checked_in_by,
      pickup_family_id,
      pickup_family_label
    )
    select
      es.student_id,
      v_today,
      'CALLED',
      now(),
      p_called_by,
      coalesce(v_checked_in_by, initcap(p_called_by)),
      v_requesting_family_id,
      public.pickup_family_label(v_requesting_family_id)
    from eligible_students es
    on conflict (student_id, date)
    do update set
      status = excluded.status,
      called_at = excluded.called_at,
      called_by = excluded.called_by,
      checked_in_by = excluded.checked_in_by,
      pickup_family_id = excluded.pickup_family_id,
      pickup_family_label = excluded.pickup_family_label
    returning student_id
  ),
  response_rows as (
    select
      f.id as family_id,
      f.carpool_number,
      public.family_display_name(
        f.parent_names,
        f.parent_one_title,
        f.parent_one_first_name,
        f.parent_one_last_name,
        f.parent_two_title,
        f.parent_two_first_name,
        f.parent_two_last_name
      ) as display_name,
      s.id as student_id,
      s.first_name,
      s.last_name,
      c.name as class_name
    from public.students s
    join public.families f on f.id = s.family_id
    join public.classes c on c.id = s.class_id
    join upserted u on u.student_id = s.id
  ),
  skipped_rows as (
    select
      f.id as family_id,
      f.carpool_number,
      public.family_display_name(
        f.parent_names,
        f.parent_one_title,
        f.parent_one_first_name,
        f.parent_one_last_name,
        f.parent_two_title,
        f.parent_two_first_name,
        f.parent_two_last_name
      ) as display_name,
      s.id as student_id,
      s.first_name,
      s.last_name,
      c.name as class_name,
      cds.retry_at
    from selected_students ss
    join cooldown_students cds on cds.student_id = ss.student_id
    join public.students s on s.id = ss.student_id
    join public.families f on f.id = s.family_id
    join public.classes c on c.id = s.class_id
  ),
  grouped as (
    select
      rr.family_id,
      rr.carpool_number,
      rr.display_name,
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
    group by rr.family_id, rr.carpool_number, rr.display_name
    order by rr.carpool_number
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'family_id', g.family_id,
        'carpool_number', g.carpool_number,
        'display_name', g.display_name,
        'students', g.students
      )
      order by g.carpool_number
    ),
    '[]'::jsonb
  )
  into v_called
  from grouped g;

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
  cooldown_students as (
    select cds.student_id, cds.retry_at
    from public.parent_reping_cooldown_students(
      p_called_by,
      coalesce((select array_agg(ss.student_id) from selected_students ss), '{}'::uuid[]),
      v_today
    ) cds
  ),
  skipped_rows as (
    select
      f.id as family_id,
      f.carpool_number,
      public.family_display_name(
        f.parent_names,
        f.parent_one_title,
        f.parent_one_first_name,
        f.parent_one_last_name,
        f.parent_two_title,
        f.parent_two_first_name,
        f.parent_two_last_name
      ) as display_name,
      s.id as student_id,
      s.first_name,
      s.last_name,
      c.name as class_name,
      cds.retry_at
    from selected_students ss
    join cooldown_students cds on cds.student_id = ss.student_id
    join public.students s on s.id = ss.student_id
    join public.families f on f.id = s.family_id
    join public.classes c on c.id = s.class_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'family_id', sr.family_id,
        'carpool_number', sr.carpool_number,
        'display_name', sr.display_name,
        'student_id', sr.student_id,
        'first_name', sr.first_name,
        'last_name', sr.last_name,
        'class_name', sr.class_name,
        'retry_at', sr.retry_at
      )
      order by sr.last_name, sr.first_name
    ),
    '[]'::jsonb
  )
  into v_skipped
  from skipped_rows sr;

  return jsonb_build_object(
    'called_by', p_called_by,
    'checked_in_by', coalesce(v_checked_in_by, initcap(p_called_by)),
    'families', v_called,
    'skipped_students', v_skipped
  );
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

drop function if exists public.create_carpool_preset(integer, text, uuid[]);
create or replace function public.create_carpool_preset(
  p_owner_carpool_number integer,
  p_name text,
  p_student_ids uuid[],
  p_weekdays text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public.school_today();
  v_owner_family_id uuid;
  v_preset_id uuid;
  v_invalid_count integer;
  v_name text := btrim(coalesce(p_name, ''));
  v_weekdays text[];
begin
  if v_name = '' then
    raise exception 'Name is required';
  end if;

  v_weekdays := public.normalize_carpool_preset_weekdays(p_weekdays);
  if coalesce(array_length(v_weekdays, 1), 0) = 0 then
    raise exception 'Select at least one day';
  end if;

  v_owner_family_id := public.family_id_for_carpool(p_owner_carpool_number);
  if v_owner_family_id is null then
    raise exception 'Carpool number not found';
  end if;

  if coalesce(array_length(p_student_ids, 1), 0) = 0 then
    raise exception 'Select at least one student';
  end if;

  select count(*)
  into v_invalid_count
  from (
    select distinct sid
    from unnest(p_student_ids) sid
  ) submitted
  left join public.allowed_students_for_family(v_owner_family_id, v_today) allowed
    on allowed.student_id = submitted.sid
  where allowed.student_id is null;

  if v_invalid_count > 0 then
    raise exception 'Saved carpools can only include students you are currently allowed to pick up';
  end if;

  insert into public.carpool_presets (owner_family_id, name, weekdays)
  values (v_owner_family_id, v_name, v_weekdays)
  returning id into v_preset_id;

  insert into public.carpool_preset_students (preset_id, student_id)
  select v_preset_id, submitted.sid
  from (
    select distinct sid
    from unnest(p_student_ids) sid
  ) submitted;

  return jsonb_build_object('preset_id', v_preset_id);
exception
  when unique_violation then
    raise exception 'You already have a saved carpool with this name';
end;
$$;

drop function if exists public.update_carpool_preset(uuid, integer, text, uuid[]);
create or replace function public.update_carpool_preset(
  p_preset_id uuid,
  p_owner_carpool_number integer,
  p_name text,
  p_student_ids uuid[],
  p_weekdays text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public.school_today();
  v_owner_family_id uuid;
  v_existing_owner uuid;
  v_invalid_count integer;
  v_name text := btrim(coalesce(p_name, ''));
  v_weekdays text[];
begin
  if v_name = '' then
    raise exception 'Name is required';
  end if;

  v_weekdays := public.normalize_carpool_preset_weekdays(p_weekdays);
  if coalesce(array_length(v_weekdays, 1), 0) = 0 then
    raise exception 'Select at least one day';
  end if;

  v_owner_family_id := public.family_id_for_carpool(p_owner_carpool_number);
  if v_owner_family_id is null then
    raise exception 'Carpool number not found';
  end if;

  select cp.owner_family_id
  into v_existing_owner
  from public.carpool_presets cp
  where cp.id = p_preset_id;

  if v_existing_owner is null or v_existing_owner <> v_owner_family_id then
    raise exception 'Saved carpool not found';
  end if;

  if coalesce(array_length(p_student_ids, 1), 0) = 0 then
    raise exception 'Select at least one student';
  end if;

  select count(*)
  into v_invalid_count
  from (
    select distinct sid
    from unnest(p_student_ids) sid
  ) submitted
  left join public.allowed_students_for_family(v_owner_family_id, v_today) allowed
    on allowed.student_id = submitted.sid
  where allowed.student_id is null;

  if v_invalid_count > 0 then
    raise exception 'Saved carpools can only include students you are currently allowed to pick up';
  end if;

  update public.carpool_presets
  set name = v_name,
      weekdays = v_weekdays
  where id = p_preset_id;

  delete from public.carpool_preset_students
  where preset_id = p_preset_id;

  insert into public.carpool_preset_students (preset_id, student_id)
  select p_preset_id, submitted.sid
  from (
    select distinct sid
    from unnest(p_student_ids) sid
  ) submitted;

  return jsonb_build_object('preset_id', p_preset_id);
exception
  when unique_violation then
    raise exception 'You already have a saved carpool with this name';
end;
$$;

create or replace function public.delete_carpool_preset(
  p_preset_id uuid,
  p_owner_carpool_number integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_family_id uuid;
  v_deleted_count integer;
begin
  v_owner_family_id := public.family_id_for_carpool(p_owner_carpool_number);
  if v_owner_family_id is null then
    raise exception 'Carpool number not found';
  end if;

  delete from public.carpool_presets cp
  where cp.id = p_preset_id
    and cp.owner_family_id = v_owner_family_id;

  get diagnostics v_deleted_count = row_count;

  if v_deleted_count = 0 then
    raise exception 'Saved carpool not found';
  end if;

  return true;
end;
$$;

create or replace function public.submit_carpool_preset_check_in(
  p_preset_id uuid,
  p_owner_carpool_number integer,
  p_called_by text,
  p_checked_in_by text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public.school_today();
  v_owner_family_id uuid;
  v_preset record;
  v_called jsonb := '[]'::jsonb;
  v_removed jsonb := '[]'::jsonb;
  v_remaining_count integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_checked_in_by text := nullif(btrim(p_checked_in_by), '');
begin
  if p_called_by not in ('parent', 'spotter') then
    raise exception 'Invalid caller';
  end if;

  if p_called_by = 'spotter' and not public.is_spotter_or_admin() then
    raise exception 'Spotter authentication required';
  end if;

  v_owner_family_id := public.family_id_for_carpool(p_owner_carpool_number);
  if v_owner_family_id is null then
    raise exception 'Carpool number not found';
  end if;

  select cp.id, cp.name
  into v_preset
  from public.carpool_presets cp
  where cp.id = p_preset_id
    and cp.owner_family_id = v_owner_family_id;

  if v_preset.id is null then
    raise exception 'Saved carpool not found';
  end if;

  with invalid_students as (
    select
      s.id as student_id,
      s.family_id,
      f.carpool_number,
      public.family_display_name(
        f.parent_names,
        f.parent_one_title,
        f.parent_one_first_name,
        f.parent_one_last_name,
        f.parent_two_title,
        f.parent_two_first_name,
        f.parent_two_last_name
      ) as display_name,
      s.first_name,
      s.last_name,
      c.name as class_name
    from public.carpool_preset_students cps
    join public.students s on s.id = cps.student_id
    join public.families f on f.id = s.family_id
    join public.classes c on c.id = s.class_id
    where cps.preset_id = p_preset_id
      and not exists (
        select 1
        from public.allowed_students_for_family(v_owner_family_id, v_today) allowed
        where allowed.student_id = cps.student_id
      )
  ),
  deleted as (
    delete from public.carpool_preset_students cps
    using invalid_students invalid
    where cps.preset_id = p_preset_id
      and cps.student_id = invalid.student_id
    returning invalid.student_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'student_id', invalid.student_id,
        'family_id', invalid.family_id,
        'carpool_number', invalid.carpool_number,
        'display_name', invalid.display_name,
        'first_name', invalid.first_name,
        'last_name', invalid.last_name,
        'class_name', invalid.class_name
      )
      order by invalid.last_name, invalid.first_name
    ),
    '[]'::jsonb
  )
  into v_removed
  from invalid_students invalid;

  with remaining_students as (
    select
      s.id as student_id,
      s.family_id
    from public.carpool_preset_students cps
    join public.students s on s.id = cps.student_id
    where cps.preset_id = p_preset_id
  )
  select count(*) into v_remaining_count
  from remaining_students;

  if v_remaining_count = 0 then
    return jsonb_build_object(
      'families', '[]'::jsonb,
      'removed_students', v_removed,
      'preset', jsonb_build_object(
        'preset_id', v_preset.id,
        'name', v_preset.name
      ),
      'is_empty_after_cleanup', true
    );
  end if;

  with remaining_students as (
    select
      s.id as student_id,
      s.family_id
    from public.carpool_preset_students cps
    join public.students s on s.id = cps.student_id
    where cps.preset_id = p_preset_id
  ),
  cooldown_students as (
    select cds.student_id, cds.retry_at
    from public.parent_reping_cooldown_students(
      p_called_by,
      coalesce((select array_agg(rs.student_id) from remaining_students rs), '{}'::uuid[]),
      v_today
    ) cds
  ),
  eligible_students as (
    select rs.student_id, rs.family_id
    from remaining_students rs
    left join cooldown_students cds on cds.student_id = rs.student_id
    where cds.student_id is null
  ),
  upserted as (
    insert into public.daily_status (
      student_id,
      date,
      status,
      called_at,
      called_by,
      checked_in_by,
      pickup_family_id,
      pickup_family_label
    )
    select
      es.student_id,
      v_today,
      'CALLED',
      now(),
      p_called_by,
      coalesce(v_checked_in_by, initcap(p_called_by)),
      v_owner_family_id,
      public.pickup_family_label(v_owner_family_id)
    from eligible_students es
    on conflict (student_id, date)
    do update set
      status = excluded.status,
      called_at = excluded.called_at,
      called_by = excluded.called_by,
      checked_in_by = excluded.checked_in_by,
      pickup_family_id = excluded.pickup_family_id,
      pickup_family_label = excluded.pickup_family_label
    returning student_id
  ),
  response_rows as (
    select
      f.id as family_id,
      f.carpool_number,
      public.family_display_name(
        f.parent_names,
        f.parent_one_title,
        f.parent_one_first_name,
        f.parent_one_last_name,
        f.parent_two_title,
        f.parent_two_first_name,
        f.parent_two_last_name
      ) as display_name,
      s.id as student_id,
      s.first_name,
      s.last_name,
      c.name as class_name
    from public.students s
    join public.families f on f.id = s.family_id
    join public.classes c on c.id = s.class_id
    join upserted u on u.student_id = s.id
  ),
  skipped_rows as (
    select
      f.id as family_id,
      f.carpool_number,
      public.family_display_name(
        f.parent_names,
        f.parent_one_title,
        f.parent_one_first_name,
        f.parent_one_last_name,
        f.parent_two_title,
        f.parent_two_first_name,
        f.parent_two_last_name
      ) as display_name,
      s.id as student_id,
      s.first_name,
      s.last_name,
      c.name as class_name,
      cds.retry_at
    from remaining_students rs
    join cooldown_students cds on cds.student_id = rs.student_id
    join public.students s on s.id = rs.student_id
    join public.families f on f.id = s.family_id
    join public.classes c on c.id = s.class_id
  ),
  grouped as (
    select
      rr.family_id,
      rr.carpool_number,
      rr.display_name,
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
    group by rr.family_id, rr.carpool_number, rr.display_name
    order by rr.carpool_number
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'family_id', g.family_id,
        'carpool_number', g.carpool_number,
        'display_name', g.display_name,
        'students', g.students
      )
      order by g.carpool_number
    ),
    '[]'::jsonb
  )
  into v_called
  from grouped g;

  with remaining_students as (
    select
      s.id as student_id,
      s.family_id
    from public.carpool_preset_students cps
    join public.students s on s.id = cps.student_id
    where cps.preset_id = p_preset_id
  ),
  cooldown_students as (
    select cds.student_id, cds.retry_at
    from public.parent_reping_cooldown_students(
      p_called_by,
      coalesce((select array_agg(rs.student_id) from remaining_students rs), '{}'::uuid[]),
      v_today
    ) cds
  ),
  skipped_rows as (
    select
      f.id as family_id,
      f.carpool_number,
      public.family_display_name(
        f.parent_names,
        f.parent_one_title,
        f.parent_one_first_name,
        f.parent_one_last_name,
        f.parent_two_title,
        f.parent_two_first_name,
        f.parent_two_last_name
      ) as display_name,
      s.id as student_id,
      s.first_name,
      s.last_name,
      c.name as class_name,
      cds.retry_at
    from remaining_students rs
    join cooldown_students cds on cds.student_id = rs.student_id
    join public.students s on s.id = rs.student_id
    join public.families f on f.id = s.family_id
    join public.classes c on c.id = s.class_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'family_id', sr.family_id,
        'carpool_number', sr.carpool_number,
        'display_name', sr.display_name,
        'student_id', sr.student_id,
        'first_name', sr.first_name,
        'last_name', sr.last_name,
        'class_name', sr.class_name,
        'retry_at', sr.retry_at
      )
      order by sr.last_name, sr.first_name
    ),
    '[]'::jsonb
  )
  into v_skipped
  from skipped_rows sr;

  return jsonb_build_object(
    'called_by', p_called_by,
    'checked_in_by', coalesce(v_checked_in_by, initcap(p_called_by)),
    'families', v_called,
    'skipped_students', v_skipped,
    'removed_students', v_removed,
    'preset', jsonb_build_object(
      'preset_id', v_preset.id,
      'name', v_preset.name
    ),
    'is_empty_after_cleanup', false
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
      public.family_display_name(
        rf.parent_names,
        rf.parent_one_title,
        rf.parent_one_first_name,
        rf.parent_one_last_name,
        rf.parent_two_title,
        rf.parent_two_first_name,
        rf.parent_two_last_name
      ) as receiving_display_name,
      rf.parent_one_title,
      rf.parent_one_first_name,
      rf.parent_one_last_name,
      rf.parent_two_title,
      rf.parent_two_first_name,
      rf.parent_two_last_name,
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
      ar.receiving_display_name,
      ar.parent_one_title,
      ar.parent_one_first_name,
      ar.parent_one_last_name,
      ar.parent_two_title,
      ar.parent_two_first_name,
      ar.parent_two_last_name,
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
          'display_name', aws.receiving_display_name,
          'parent_one_title', aws.parent_one_title,
          'parent_one_first_name', aws.parent_one_first_name,
          'parent_one_last_name', aws.parent_one_last_name,
          'parent_two_title', aws.parent_two_title,
          'parent_two_first_name', aws.parent_two_first_name,
          'parent_two_last_name', aws.parent_two_last_name
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

create or replace function public.search_receiving_families(
  p_granting_carpool_number integer,
  p_query text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_granting_family_id uuid;
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_result jsonb := '[]'::jsonb;
begin
  v_granting_family_id := public.family_id_for_carpool(p_granting_carpool_number);
  if v_granting_family_id is null then
    raise exception 'Carpool number not found';
  end if;

  if v_query is null or char_length(v_query) < 2 then
    return v_result;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'family_id', family_match.id,
        'display_name', family_match.display_name,
        'parent_one_title', family_match.parent_one_title,
        'parent_one_first_name', family_match.parent_one_first_name,
        'parent_one_last_name', family_match.parent_one_last_name,
        'parent_two_title', family_match.parent_two_title,
        'parent_two_first_name', family_match.parent_two_first_name,
        'parent_two_last_name', family_match.parent_two_last_name
      )
      order by family_match.sort_rank, lower(family_match.display_name), family_match.id
    ),
    '[]'::jsonb
  )
  into v_result
  from (
    select
      f.id,
      public.family_display_name(
        f.parent_names,
        f.parent_one_title,
        f.parent_one_first_name,
        f.parent_one_last_name,
        f.parent_two_title,
        f.parent_two_first_name,
        f.parent_two_last_name
      ) as display_name,
      f.parent_one_title,
      f.parent_one_first_name,
      f.parent_one_last_name,
      f.parent_two_title,
      f.parent_two_first_name,
      f.parent_two_last_name,
      case
        when lower(public.family_display_name(
          f.parent_names,
          f.parent_one_title,
          f.parent_one_first_name,
          f.parent_one_last_name,
          f.parent_two_title,
          f.parent_two_first_name,
          f.parent_two_last_name
        )) = lower(v_query) then 0
        when lower(public.family_display_name(
          f.parent_names,
          f.parent_one_title,
          f.parent_one_first_name,
          f.parent_one_last_name,
          f.parent_two_title,
          f.parent_two_first_name,
          f.parent_two_last_name
        )) like lower(v_query) || '%' then 1
        else 2
      end as sort_rank
    from public.families f
    where f.id <> v_granting_family_id
      and public.family_search_text(
        f.parent_names,
        f.parent_one_title,
        f.parent_one_first_name,
        f.parent_one_last_name,
        f.parent_two_title,
        f.parent_two_first_name,
        f.parent_two_last_name
      ) ilike '%' || v_query || '%'
    order by
      case
        when lower(public.family_display_name(
          f.parent_names,
          f.parent_one_title,
          f.parent_one_first_name,
          f.parent_one_last_name,
          f.parent_two_title,
          f.parent_two_first_name,
          f.parent_two_last_name
        )) = lower(v_query) then 0
        when lower(public.family_display_name(
          f.parent_names,
          f.parent_one_title,
          f.parent_one_first_name,
          f.parent_one_last_name,
          f.parent_two_title,
          f.parent_two_first_name,
          f.parent_two_last_name
        )) like lower(v_query) || '%' then 1
        else 2
      end,
      lower(public.family_display_name(
        f.parent_names,
        f.parent_one_title,
        f.parent_one_first_name,
        f.parent_one_last_name,
        f.parent_two_title,
        f.parent_two_first_name,
        f.parent_two_last_name
      )),
      f.id
    limit 12
  ) family_match;

  return v_result;
end;
$$;

create or replace function public.create_pickup_authorization_for_family(
  p_granting_carpool_number integer,
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

  select f.id
  into v_receiving_family_id
  from public.families f
  where f.id = p_receiving_family_id
  limit 1;

  if v_granting_family_id is null or v_receiving_family_id is null then
    raise exception 'Family not found';
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
      'receiving_family_id', p_receiving_family_id
    )
  );

  return jsonb_build_object('authorization_id', v_authorization_id);
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

  perform public.prune_invalid_carpool_preset_students(v_receiving_family_id, public.school_today());

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

  perform public.prune_invalid_carpool_preset_students(v_receiving_family_id, public.school_today());

  return true;
end;
$$;

create or replace function public.admin_create_pickup_authorization(
  p_granting_family_id uuid,
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
declare
  v_authorization_id uuid;
  v_invalid_count integer;
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  if p_starts_on is null or p_ends_on is null or p_starts_on > p_ends_on then
    raise exception 'Invalid date range';
  end if;

  if p_granting_family_id is null or p_receiving_family_id is null then
    raise exception 'Choose both families';
  end if;

  if p_granting_family_id = p_receiving_family_id then
    raise exception 'Receiving family must be different';
  end if;

  if coalesce(array_length(p_student_ids, 1), 0) = 0 then
    raise exception 'Select at least one student';
  end if;

  select count(*)
  into v_invalid_count
  from unnest(p_student_ids) sid
  left join public.students s on s.id = sid and s.family_id = p_granting_family_id
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
    p_granting_family_id,
    p_receiving_family_id,
    p_starts_on,
    p_ends_on
  )
  returning id into v_authorization_id;

  insert into public.pickup_authorization_students (authorization_id, student_id)
  select v_authorization_id, sid
  from (
    select distinct sid
    from unnest(p_student_ids) sid
  ) submitted;

  perform public.write_pickup_authorization_audit(
    v_authorization_id,
    'CREATED',
    'admin',
    p_granting_family_id,
    p_receiving_family_id,
    p_starts_on,
    p_ends_on,
    p_student_ids
  );

  return jsonb_build_object('authorization_id', v_authorization_id);
end;
$$;

create or replace function public.admin_update_pickup_authorization(
  p_authorization_id uuid,
  p_granting_family_id uuid,
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
  v_receiving_family_id uuid;
  v_is_revoked boolean;
  v_invalid_count integer;
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  if p_starts_on is null or p_ends_on is null or p_starts_on > p_ends_on then
    raise exception 'Invalid date range';
  end if;

  if p_granting_family_id is null then
    raise exception 'Choose a granting family';
  end if;

  select pa.receiving_family_id, pa.is_revoked
  into v_receiving_family_id, v_is_revoked
  from public.pickup_authorizations pa
  where pa.id = p_authorization_id
    and pa.granting_family_id = p_granting_family_id;

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
  left join public.students s on s.id = sid and s.family_id = p_granting_family_id
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
  from (
    select distinct sid
    from unnest(p_student_ids) sid
  ) submitted;

  perform public.write_pickup_authorization_audit(
    p_authorization_id,
    'UPDATED',
    'admin',
    p_granting_family_id,
    v_receiving_family_id,
    p_starts_on,
    p_ends_on,
    p_student_ids
  );

  perform public.prune_invalid_carpool_preset_students(v_receiving_family_id, public.school_today());

  return jsonb_build_object('authorization_id', p_authorization_id);
end;
$$;

create or replace function public.admin_revoke_pickup_authorization(
  p_authorization_id uuid
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
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  select pa.granting_family_id, pa.receiving_family_id, pa.starts_on, pa.ends_on
  into v_granting_family_id, v_receiving_family_id, v_starts_on, v_ends_on
  from public.pickup_authorizations pa
  where pa.id = p_authorization_id
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
      revoked_by = 'admin'
  where id = p_authorization_id;

  perform public.write_pickup_authorization_audit(
    p_authorization_id,
    'REVOKED',
    'admin',
    v_granting_family_id,
    v_receiving_family_id,
    v_starts_on,
    v_ends_on,
    v_student_ids
  );

  perform public.prune_invalid_carpool_preset_students(v_receiving_family_id, public.school_today());

  return true;
end;
$$;

drop function if exists public.admin_create_carpool_preset(uuid, text, uuid[]);
create or replace function public.admin_create_carpool_preset(
  p_owner_family_id uuid,
  p_name text,
  p_student_ids uuid[],
  p_weekdays text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public.school_today();
  v_preset_id uuid;
  v_invalid_count integer;
  v_name text := btrim(coalesce(p_name, ''));
  v_weekdays text[];
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  if v_name = '' then
    raise exception 'Name is required';
  end if;

  v_weekdays := public.normalize_carpool_preset_weekdays(p_weekdays);
  if coalesce(array_length(v_weekdays, 1), 0) = 0 then
    raise exception 'Select at least one day';
  end if;

  if p_owner_family_id is null then
    raise exception 'Choose an owner family';
  end if;

  if coalesce(array_length(p_student_ids, 1), 0) = 0 then
    raise exception 'Select at least one student';
  end if;

  select count(*)
  into v_invalid_count
  from (
    select distinct sid
    from unnest(p_student_ids) sid
  ) submitted
  left join public.allowed_students_for_family(p_owner_family_id, v_today) allowed
    on allowed.student_id = submitted.sid
  where allowed.student_id is null;

  if v_invalid_count > 0 then
    raise exception 'Saved carpools can only include students the family is currently allowed to pick up';
  end if;

  insert into public.carpool_presets (owner_family_id, name, weekdays)
  values (p_owner_family_id, v_name, v_weekdays)
  returning id into v_preset_id;

  insert into public.carpool_preset_students (preset_id, student_id)
  select v_preset_id, submitted.sid
  from (
    select distinct sid
    from unnest(p_student_ids) sid
  ) submitted;

  return jsonb_build_object('preset_id', v_preset_id);
exception
  when unique_violation then
    raise exception 'That family already has a saved carpool with this name';
end;
$$;

drop function if exists public.admin_update_carpool_preset(uuid, uuid, text, uuid[]);
create or replace function public.admin_update_carpool_preset(
  p_preset_id uuid,
  p_owner_family_id uuid,
  p_name text,
  p_student_ids uuid[],
  p_weekdays text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public.school_today();
  v_existing_owner uuid;
  v_invalid_count integer;
  v_name text := btrim(coalesce(p_name, ''));
  v_weekdays text[];
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  if v_name = '' then
    raise exception 'Name is required';
  end if;

  v_weekdays := public.normalize_carpool_preset_weekdays(p_weekdays);
  if coalesce(array_length(v_weekdays, 1), 0) = 0 then
    raise exception 'Select at least one day';
  end if;

  select cp.owner_family_id
  into v_existing_owner
  from public.carpool_presets cp
  where cp.id = p_preset_id;

  if v_existing_owner is null or v_existing_owner <> p_owner_family_id then
    raise exception 'Saved carpool not found';
  end if;

  if coalesce(array_length(p_student_ids, 1), 0) = 0 then
    raise exception 'Select at least one student';
  end if;

  select count(*)
  into v_invalid_count
  from (
    select distinct sid
    from unnest(p_student_ids) sid
  ) submitted
  left join public.allowed_students_for_family(p_owner_family_id, v_today) allowed
    on allowed.student_id = submitted.sid
  where allowed.student_id is null;

  if v_invalid_count > 0 then
    raise exception 'Saved carpools can only include students the family is currently allowed to pick up';
  end if;

  update public.carpool_presets
  set name = v_name,
      weekdays = v_weekdays
  where id = p_preset_id;

  delete from public.carpool_preset_students
  where preset_id = p_preset_id;

  insert into public.carpool_preset_students (preset_id, student_id)
  select p_preset_id, submitted.sid
  from (
    select distinct sid
    from unnest(p_student_ids) sid
  ) submitted;

  return jsonb_build_object('preset_id', p_preset_id);
exception
  when unique_violation then
    raise exception 'That family already has a saved carpool with this name';
end;
$$;

create or replace function public.admin_delete_carpool_preset(
  p_preset_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted_count integer;
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  delete from public.carpool_presets
  where id = p_preset_id;

  get diagnostics v_deleted_count = row_count;

  if v_deleted_count = 0 then
    raise exception 'Saved carpool not found';
  end if;

  return true;
end;
$$;

grant execute on function public.family_id_for_carpool(integer) to anon, authenticated;
grant execute on function public.normalize_carpool_preset_weekdays(text[]) to anon, authenticated;
grant execute on function public.allowed_students_for_family(uuid, date) to authenticated;
grant execute on function public.active_authorized_students_for_receiver(uuid, date) to authenticated;
grant execute on function public.prune_invalid_carpool_preset_students(uuid, date) to authenticated;
grant execute on function public.get_parent_checkin_context(integer) to anon, authenticated;
grant execute on function public.submit_check_in_request(integer, jsonb, text, text) to anon, authenticated;
grant execute on function public.cancel_parent_check_in_request(integer, uuid[]) to anon, authenticated;
grant execute on function public.get_pending_scheduled_pickup_request(integer) to anon, authenticated;
grant execute on function public.create_scheduled_pickup_request(integer, jsonb, timestamptz, text) to anon, authenticated;
grant execute on function public.cancel_scheduled_pickup_request(uuid, integer) to anon, authenticated;
revoke execute on function public.scheduled_pickup_request_response(uuid) from public, anon, authenticated;
revoke execute on function public.process_due_scheduled_pickup_requests(integer) from public, anon, authenticated;
grant execute on function public.process_due_scheduled_pickup_requests(integer) to service_role;
grant execute on function public.get_family_authorizations(integer) to anon, authenticated;
grant execute on function public.search_receiving_families(integer, text) to anon, authenticated;
grant execute on function public.create_pickup_authorization_for_family(integer, uuid, uuid[], date, date) to anon, authenticated;
grant execute on function public.create_pickup_authorization(integer, integer, uuid[], date, date) to anon, authenticated;
grant execute on function public.update_pickup_authorization(uuid, integer, uuid[], date, date) to anon, authenticated;
grant execute on function public.revoke_pickup_authorization(uuid, integer) to anon, authenticated;
grant execute on function public.create_carpool_preset(integer, text, uuid[], text[]) to anon, authenticated;
grant execute on function public.update_carpool_preset(uuid, integer, text, uuid[], text[]) to anon, authenticated;
grant execute on function public.delete_carpool_preset(uuid, integer) to anon, authenticated;
grant execute on function public.submit_carpool_preset_check_in(uuid, integer, text, text) to anon, authenticated;
grant execute on function public.admin_create_pickup_authorization(uuid, uuid, uuid[], date, date) to authenticated;
grant execute on function public.admin_update_pickup_authorization(uuid, uuid, uuid[], date, date) to authenticated;
grant execute on function public.admin_revoke_pickup_authorization(uuid) to authenticated;
grant execute on function public.admin_create_carpool_preset(uuid, text, uuid[], text[]) to authenticated;
grant execute on function public.admin_update_carpool_preset(uuid, uuid, text, uuid[], text[]) to authenticated;
grant execute on function public.admin_delete_carpool_preset(uuid) to authenticated;

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
alter table public.pickup_notification_queue enable row level security;
alter table public.carpool_presets enable row level security;
alter table public.carpool_preset_students enable row level security;
alter table public.scheduled_pickup_requests enable row level security;

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
drop policy if exists pickup_notification_queue_select_admin on public.pickup_notification_queue;
drop policy if exists pickup_notification_queue_admin_all on public.pickup_notification_queue;
drop policy if exists carpool_presets_select_staff on public.carpool_presets;
drop policy if exists carpool_presets_admin_all on public.carpool_presets;
drop policy if exists carpool_preset_students_select_staff on public.carpool_preset_students;
drop policy if exists carpool_preset_students_admin_all on public.carpool_preset_students;
drop policy if exists scheduled_pickup_requests_select_admin on public.scheduled_pickup_requests;
drop policy if exists scheduled_pickup_requests_admin_all on public.scheduled_pickup_requests;
drop policy if exists student_call_audio_select_public on storage.objects;
drop policy if exists student_call_audio_insert_admin on storage.objects;
drop policy if exists student_call_audio_update_admin on storage.objects;
drop policy if exists student_call_audio_delete_admin on storage.objects;

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

create policy pickup_notification_queue_select_admin on public.pickup_notification_queue
for select using (public.is_admin());

create policy pickup_notification_queue_admin_all on public.pickup_notification_queue
for all using (public.is_admin()) with check (public.is_admin());

create policy carpool_presets_select_staff on public.carpool_presets
for select using (public.is_spotter_or_admin());

create policy carpool_presets_admin_all on public.carpool_presets
for all using (public.is_admin()) with check (public.is_admin());

create policy carpool_preset_students_select_staff on public.carpool_preset_students
for select using (public.is_spotter_or_admin());

create policy carpool_preset_students_admin_all on public.carpool_preset_students
for all using (public.is_admin()) with check (public.is_admin());

create policy scheduled_pickup_requests_select_admin on public.scheduled_pickup_requests
for select using (public.is_admin());

create policy scheduled_pickup_requests_admin_all on public.scheduled_pickup_requests
for all using (public.is_admin()) with check (public.is_admin());

create policy student_call_audio_select_public on storage.objects
for select using (bucket_id = 'student-call-audio');

create policy student_call_audio_insert_admin on storage.objects
for insert with check (bucket_id = 'student-call-audio' and public.is_admin());

create policy student_call_audio_update_admin on storage.objects
for update using (bucket_id = 'student-call-audio' and public.is_admin()) with check (bucket_id = 'student-call-audio' and public.is_admin());

create policy student_call_audio_delete_admin on storage.objects
for delete using (bucket_id = 'student-call-audio' and public.is_admin());
