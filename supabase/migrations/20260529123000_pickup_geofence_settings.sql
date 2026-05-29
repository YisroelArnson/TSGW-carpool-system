create table if not exists public.pickup_geofence_settings (
  id boolean primary key default true,
  is_enabled boolean not null default false,
  school_latitude numeric(9,6),
  school_longitude numeric(9,6),
  radius_meters integer not null default 300,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pickup_geofence_settings_singleton check (id),
  constraint pickup_geofence_settings_latitude_check
    check (school_latitude is null or (school_latitude >= -90 and school_latitude <= 90)),
  constraint pickup_geofence_settings_longitude_check
    check (school_longitude is null or (school_longitude >= -180 and school_longitude <= 180)),
  constraint pickup_geofence_settings_radius_check
    check (radius_meters between 15 and 5000),
  constraint pickup_geofence_settings_enabled_check
    check (
      not is_enabled
      or (
        school_latitude is not null
        and school_longitude is not null
        and radius_meters between 15 and 5000
      )
    )
);

insert into public.pickup_geofence_settings (id, is_enabled, radius_meters)
values (true, false, 300)
on conflict (id) do nothing;

drop trigger if exists trg_pickup_geofence_settings_updated_at on public.pickup_geofence_settings;
create trigger trg_pickup_geofence_settings_updated_at
before update on public.pickup_geofence_settings
for each row execute function public.set_updated_at();

create or replace function public.get_pickup_geofence_settings()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'is_enabled',
      coalesce(settings.is_enabled, false)
      and settings.school_latitude is not null
      and settings.school_longitude is not null
      and settings.radius_meters between 15 and 5000,
    'is_configured',
      settings.school_latitude is not null
      and settings.school_longitude is not null
      and settings.radius_meters between 15 and 5000,
    'school_latitude', settings.school_latitude,
    'school_longitude', settings.school_longitude,
    'radius_meters', settings.radius_meters,
    'updated_at', settings.updated_at
  )
  from public.pickup_geofence_settings settings
  where settings.id = true;
$$;

create or replace function public.update_pickup_geofence_settings(
  p_is_enabled boolean,
  p_school_latitude numeric,
  p_school_longitude numeric,
  p_radius_meters integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_radius_meters integer := coalesce(p_radius_meters, 300);
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  if p_school_latitude is not null and (p_school_latitude < -90 or p_school_latitude > 90) then
    raise exception 'Latitude must be between -90 and 90';
  end if;

  if p_school_longitude is not null and (p_school_longitude < -180 or p_school_longitude > 180) then
    raise exception 'Longitude must be between -180 and 180';
  end if;

  if v_radius_meters < 15 or v_radius_meters > 5000 then
    raise exception 'Radius must be between 15 and 5000 meters';
  end if;

  if coalesce(p_is_enabled, false) and (p_school_latitude is null or p_school_longitude is null) then
    raise exception 'School latitude and longitude are required before enabling auto call';
  end if;

  insert into public.pickup_geofence_settings (
    id,
    is_enabled,
    school_latitude,
    school_longitude,
    radius_meters,
    updated_by
  ) values (
    true,
    coalesce(p_is_enabled, false),
    p_school_latitude,
    p_school_longitude,
    v_radius_meters,
    auth.uid()
  )
  on conflict (id) do update
  set
    is_enabled = excluded.is_enabled,
    school_latitude = excluded.school_latitude,
    school_longitude = excluded.school_longitude,
    radius_meters = excluded.radius_meters,
    updated_by = excluded.updated_by;

  return public.get_pickup_geofence_settings();
end;
$$;

grant execute on function public.get_pickup_geofence_settings() to anon, authenticated;
grant execute on function public.update_pickup_geofence_settings(boolean, numeric, numeric, integer) to authenticated;

alter table public.pickup_geofence_settings enable row level security;

drop policy if exists pickup_geofence_settings_admin_select on public.pickup_geofence_settings;
drop policy if exists pickup_geofence_settings_admin_all on public.pickup_geofence_settings;

create policy pickup_geofence_settings_admin_select on public.pickup_geofence_settings
for select using (public.is_admin());

create policy pickup_geofence_settings_admin_all on public.pickup_geofence_settings
for all using (public.is_admin()) with check (public.is_admin());
