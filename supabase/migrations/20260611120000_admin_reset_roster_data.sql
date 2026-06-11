create or replace function public.admin_reset_roster_data()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_counts jsonb;
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  select jsonb_build_object(
    'classes_deleted', (select count(*) from public.classes),
    'families_deleted', (select count(*) from public.families),
    'students_deleted', (select count(*) from public.students),
    'check_ins_deleted', (select count(*) from public.daily_status),
    'call_events_deleted', (select count(*) from public.student_call_events),
    'pickup_permissions_deleted', (select count(*) from public.pickup_authorizations),
    'saved_carpools_deleted', (select count(*) from public.carpool_presets),
    'scheduled_pickups_deleted', (select count(*) from public.scheduled_pickup_requests),
    'notification_queue_deleted', (select count(*) from public.pickup_notification_queue)
  )
  into v_counts;

  truncate table
    public.pickup_notification_queue,
    public.student_call_events,
    public.daily_status,
    public.pickup_authorization_students,
    public.pickup_authorizations,
    public.pickup_authorization_audit,
    public.carpool_preset_students,
    public.carpool_presets,
    public.scheduled_pickup_requests,
    public.students,
    public.classes,
    public.families
  restart identity cascade;

  return v_counts;
end;
$$;

revoke execute on function public.admin_reset_roster_data() from public, anon;
grant execute on function public.admin_reset_roster_data() to authenticated;
