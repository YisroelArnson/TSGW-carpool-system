alter table public.students
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

drop policy if exists student_call_audio_select_public on storage.objects;
drop policy if exists student_call_audio_insert_admin on storage.objects;
drop policy if exists student_call_audio_update_admin on storage.objects;
drop policy if exists student_call_audio_delete_admin on storage.objects;

create policy student_call_audio_select_public on storage.objects
for select using (bucket_id = 'student-call-audio');

create policy student_call_audio_insert_admin on storage.objects
for insert with check (bucket_id = 'student-call-audio' and public.is_admin());

create policy student_call_audio_update_admin on storage.objects
for update using (bucket_id = 'student-call-audio' and public.is_admin()) with check (bucket_id = 'student-call-audio' and public.is_admin());

create policy student_call_audio_delete_admin on storage.objects
for delete using (bucket_id = 'student-call-audio' and public.is_admin());
