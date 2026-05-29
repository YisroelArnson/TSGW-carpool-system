create table if not exists public.student_call_events (
  id uuid primary key default gen_random_uuid(),
  daily_status_id uuid references public.daily_status(id) on delete set null,
  student_id uuid not null references public.students(id) on delete cascade,
  date date not null,
  attempted_at timestamptz not null default now(),
  attempt_type text not null,
  called_by text,
  checked_in_by text,
  pickup_family_id uuid references public.families(id) on delete set null,
  pickup_family_label text,
  previous_called_at timestamptz,
  previous_called_by text,
  created_at timestamptz not null default now(),
  constraint student_call_events_attempt_type_check
    check (attempt_type in ('initial', 'recall'))
);

create index if not exists idx_student_call_events_date_attempted
  on public.student_call_events(date, attempted_at desc);
create index if not exists idx_student_call_events_student_date
  on public.student_call_events(student_id, date, attempted_at desc);
create index if not exists idx_student_call_events_pickup_family_date
  on public.student_call_events(pickup_family_id, date, attempted_at desc);
create index if not exists idx_student_call_events_type_date
  on public.student_call_events(attempt_type, date);

create or replace function public.record_student_call_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt_type text;
  v_previous_called_at timestamptz;
  v_previous_called_by text;
begin
  if tg_op = 'DELETE' then
    return old;
  end if;

  if new.status <> 'CALLED' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.status = 'CALLED'
      and new.status = 'CALLED'
      and old.called_at is not distinct from new.called_at
      and old.called_by is not distinct from new.called_by
      and old.checked_in_by is not distinct from new.checked_in_by
      and old.pickup_family_id is not distinct from new.pickup_family_id
      and old.pickup_family_label is not distinct from new.pickup_family_label
    then
      return new;
    end if;

    v_previous_called_at := old.called_at;
    v_previous_called_by := old.called_by;
    v_attempt_type := case when old.status = 'CALLED' then 'recall' else 'initial' end;
  else
    v_attempt_type := 'initial';
  end if;

  insert into public.student_call_events (
    daily_status_id,
    student_id,
    date,
    attempted_at,
    attempt_type,
    called_by,
    checked_in_by,
    pickup_family_id,
    pickup_family_label,
    previous_called_at,
    previous_called_by
  ) values (
    new.id,
    new.student_id,
    new.date,
    coalesce(new.called_at, now()),
    v_attempt_type,
    new.called_by,
    new.checked_in_by,
    new.pickup_family_id,
    new.pickup_family_label,
    v_previous_called_at,
    v_previous_called_by
  );

  return new;
end;
$$;

insert into public.student_call_events (
  daily_status_id,
  student_id,
  date,
  attempted_at,
  attempt_type,
  called_by,
  checked_in_by,
  pickup_family_id,
  pickup_family_label
)
select
  ds.id,
  ds.student_id,
  ds.date,
  coalesce(ds.called_at, ds.created_at, now()),
  'initial',
  ds.called_by,
  ds.checked_in_by,
  ds.pickup_family_id,
  ds.pickup_family_label
from public.daily_status ds
where ds.status = 'CALLED'
  and not exists (
    select 1
    from public.student_call_events existing
    where existing.daily_status_id = ds.id
      and existing.attempt_type = 'initial'
  );

drop trigger if exists daily_status_student_call_event on public.daily_status;
create trigger daily_status_student_call_event
after insert or update of status, called_at, called_by, checked_in_by, pickup_family_id, pickup_family_label
on public.daily_status
for each row
execute function public.record_student_call_event();

grant select on public.student_call_events to authenticated;

alter table public.student_call_events enable row level security;

drop policy if exists student_call_events_select_admin on public.student_call_events;
create policy student_call_events_select_admin on public.student_call_events
for select using (public.is_admin());
