-- Carpool Dismissal System - Supabase Schema
-- Run in Supabase SQL Editor.

create extension if not exists "pgcrypto";

create type public.status_enum as enum ('WAITING', 'CALLED');
create type public.app_role as enum ('admin', 'spotter');

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

create index if not exists idx_students_class_id on public.students(class_id);
create index if not exists idx_students_family_id on public.students(family_id);
create index if not exists idx_daily_status_date on public.daily_status(date);
create index if not exists idx_daily_status_student_date on public.daily_status(student_id, date);

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
as $$
  select exists (
    select 1
    from public.app_users u
    where u.id = auth.uid() and u.role in ('spotter', 'admin')
  );
$$;

create or replace function public.get_family_students(p_carpool_number integer)
returns table(student_id uuid, first_name text, last_name text)
language sql
security definer
set search_path = public
as $$
  select s.id, s.first_name, s.last_name
  from public.students s
  join public.families f on f.id = s.family_id
  where f.carpool_number = p_carpool_number
  order by s.last_name, s.first_name;
$$;

create or replace function public.submit_parent_check_in(
  p_carpool_number integer,
  p_student_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_family_id uuid;
  v_count integer := 0;
begin
  select id into v_family_id
  from public.families
  where carpool_number = p_carpool_number
  limit 1;

  if v_family_id is null then
    raise exception 'Carpool number not found';
  end if;

  with allowed as (
    select s.id
    from public.students s
    where s.family_id = v_family_id
      and s.id = any(p_student_ids)
  )
  insert into public.daily_status (student_id, date, status, called_at, called_by)
  select a.id, public.school_today(), 'CALLED', now(), 'parent'
  from allowed a
  on conflict (student_id, date)
  do update
    set status = excluded.status,
        called_at = excluded.called_at,
        called_by = excluded.called_by;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.get_family_students(integer) to anon, authenticated;
grant execute on function public.submit_parent_check_in(integer, uuid[]) to anon, authenticated;

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
