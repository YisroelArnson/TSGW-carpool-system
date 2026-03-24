-- Reset roster-related data while keeping auth/app_users intact.
-- Run this only when you intentionally want a clean import baseline.

truncate table
  public.daily_status,
  public.pickup_authorization_students,
  public.pickup_authorizations,
  public.pickup_authorization_audit,
  public.carpool_preset_students,
  public.carpool_presets,
  public.students,
  public.classes,
  public.families
restart identity cascade;
