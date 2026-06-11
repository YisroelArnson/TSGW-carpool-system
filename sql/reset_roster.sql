-- Reset roster-related data while keeping auth/app_users intact.
-- Run this only when you intentionally want a clean import baseline.

truncate table
  public.daily_status,
  public.student_call_events,
  public.pickup_notification_queue,
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
