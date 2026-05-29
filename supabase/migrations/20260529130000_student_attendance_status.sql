do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'attendance_status_enum'
      and n.nspname = 'public'
  ) then
    create type public.attendance_status_enum as enum ('ABSENT', 'LEFT_EARLY');
  end if;
end
$$;

alter table public.daily_status
  add column if not exists attendance_status public.attendance_status_enum,
  add column if not exists attendance_marked_at timestamptz,
  add column if not exists attendance_marked_by text,
  add column if not exists attendance_cleared_at timestamptz,
  add column if not exists attendance_cleared_by text;

create index if not exists idx_daily_status_attendance_date
  on public.daily_status(date, attendance_status)
  where attendance_status is not null;

create or replace function public.set_student_attendance_status(
  p_student_id uuid,
  p_attendance_status text,
  p_actor text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public.school_today();
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'Staff');
  v_attendance_status public.attendance_status_enum := null;
  v_row public.daily_status%rowtype;
begin
  if not public.is_spotter_or_admin() then
    raise exception 'Staff authentication required';
  end if;

  if p_student_id is null then
    raise exception 'Student is required';
  end if;

  if not exists (select 1 from public.students s where s.id = p_student_id) then
    raise exception 'Student not found';
  end if;

  if nullif(btrim(coalesce(p_attendance_status, '')), '') is not null then
    case upper(btrim(p_attendance_status))
      when 'ABSENT' then v_attendance_status := 'ABSENT';
      when 'LEFT_EARLY' then v_attendance_status := 'LEFT_EARLY';
      else raise exception 'Invalid attendance status';
    end case;
  end if;

  if v_attendance_status is null then
    update public.daily_status ds
    set
      attendance_status = null,
      attendance_cleared_at = now(),
      attendance_cleared_by = v_actor
    where ds.student_id = p_student_id
      and ds.date = v_today
    returning ds.* into v_row;

    if not found then
      insert into public.daily_status (
        student_id,
        date,
        status,
        attendance_cleared_at,
        attendance_cleared_by
      ) values (
        p_student_id,
        v_today,
        'WAITING',
        now(),
        v_actor
      )
      returning * into v_row;
    end if;
  else
    insert into public.daily_status (
      student_id,
      date,
      status,
      attendance_status,
      attendance_marked_at,
      attendance_marked_by,
      attendance_cleared_at,
      attendance_cleared_by
    ) values (
      p_student_id,
      v_today,
      'WAITING',
      v_attendance_status,
      now(),
      v_actor,
      null,
      null
    )
    on conflict (student_id, date)
    do update set
      attendance_status = excluded.attendance_status,
      attendance_marked_at = excluded.attendance_marked_at,
      attendance_marked_by = excluded.attendance_marked_by,
      attendance_cleared_at = null,
      attendance_cleared_by = null
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'student_id', v_row.student_id,
    'date', v_row.date,
    'status', v_row.status,
    'called_at', v_row.called_at,
    'called_by', v_row.called_by,
    'checked_in_by', v_row.checked_in_by,
    'pickup_family_id', v_row.pickup_family_id,
    'pickup_family_label', v_row.pickup_family_label,
    'attendance_status', v_row.attendance_status,
    'attendance_marked_at', v_row.attendance_marked_at,
    'attendance_marked_by', v_row.attendance_marked_by,
    'attendance_cleared_at', v_row.attendance_cleared_at,
    'attendance_cleared_by', v_row.attendance_cleared_by
  );
end;
$$;

grant execute on function public.set_student_attendance_status(uuid, text, text) to authenticated;

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
        'attendance_status', ds.attendance_status,
        'attendance_marked_at', ds.attendance_marked_at,
        'attendance_marked_by', ds.attendance_marked_by,
        'attendance_cleared_at', ds.attendance_cleared_at,
        'attendance_cleared_by', ds.attendance_cleared_by,
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
          'attendance_status', ds.attendance_status,
          'attendance_marked_at', ds.attendance_marked_at,
          'attendance_marked_by', ds.attendance_marked_by,
          'attendance_cleared_at', ds.attendance_cleared_at,
          'attendance_cleared_by', ds.attendance_cleared_by,
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
