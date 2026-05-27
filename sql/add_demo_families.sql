-- Add two fake parent families for tutorial/demo testing.
-- Run this in the Supabase SQL Editor or with an admin/service database connection.

with demo_families as (
  insert into public.families (
    carpool_number,
    parent_names,
    parent_one_title,
    parent_one_first_name,
    parent_one_last_name,
    parent_two_title,
    parent_two_first_name,
    parent_two_last_name,
    contact_info,
    notification_email,
    notification_enabled
  )
  values
    (
      901,
      'Menachem & Tova Goldberg',
      'Mr.',
      'Menachem',
      'Goldberg',
      'Mrs.',
      'Tova',
      'Goldberg',
      null,
      null,
      false
    ),
    (
      902,
      'Yosef & Rivka Schoenfeld',
      'Mr.',
      'Yosef',
      'Schoenfeld',
      'Mrs.',
      'Rivka',
      'Schoenfeld',
      null,
      null,
      false
    )
  on conflict (carpool_number) do update set
    parent_names = excluded.parent_names,
    parent_one_title = excluded.parent_one_title,
    parent_one_first_name = excluded.parent_one_first_name,
    parent_one_last_name = excluded.parent_one_last_name,
    parent_two_title = excluded.parent_two_title,
    parent_two_first_name = excluded.parent_two_first_name,
    parent_two_last_name = excluded.parent_two_last_name,
    notification_email = excluded.notification_email,
    notification_enabled = excluded.notification_enabled
  returning id, carpool_number
),
all_demo_families as (
  select id, carpool_number
  from demo_families
  union
  select id, carpool_number
  from public.families
  where carpool_number in (901, 902)
),
demo_students as (
  select
    family.id as family_id,
    class.id as class_id,
    student.first_name,
    student.last_name
  from (
    values
      (901, 'Chaya', 'Goldberg', '2GA'),
      (901, 'Eli', 'Goldberg', '4BA'),
      (902, 'Esti', 'Schoenfeld', '1GB'),
      (902, 'Moshe', 'Schoenfeld', '3BB')
  ) as student(carpool_number, first_name, last_name, class_name)
  join all_demo_families family on family.carpool_number = student.carpool_number
  join public.classes class on class.name = student.class_name
)
insert into public.students (
  first_name,
  last_name,
  family_id,
  class_id
)
select
  first_name,
  last_name,
  family_id,
  class_id
from demo_students
where not exists (
  select 1
  from public.students existing
  where existing.family_id = demo_students.family_id
    and lower(existing.first_name) = lower(demo_students.first_name)
    and lower(existing.last_name) = lower(demo_students.last_name)
);
