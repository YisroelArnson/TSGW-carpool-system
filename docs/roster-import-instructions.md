# Roster CSV Upload Instructions

Use these instructions when preparing a roster file for the Admin Dashboard import.

The upload can read `.csv`, `.xlsx`, and `.xls` files. If you are preparing a CSV, save the spreadsheet as **Comma Separated Values (.csv)** before uploading it.

## Required Columns

The CSV must include one row per student and these four required columns:

```csv
carpool_number,student_first_name,student_last_name,class_name
```

| Column | Required | What to enter |
| --- | --- | --- |
| `carpool_number` | Yes | The family's carpool number. Use numbers only. Siblings should use the same number. |
| `student_first_name` | Yes | Student first name. |
| `student_last_name` | Yes | Student last name. |
| `class_name` | Yes | The classroom or teacher label that should appear in the system. New class names are created automatically. |

## Recommended Full Template

Use this header row for the cleanest import:

```csv
carpool_number,student_first_name,student_last_name,class_name,parent_one_title,parent_one_first_name,parent_one_last_name,parent_two_title,parent_two_first_name,parent_two_last_name,notification_email,notification_enabled
```

Example:

```csv
carpool_number,student_first_name,student_last_name,class_name,parent_one_title,parent_one_first_name,parent_one_last_name,parent_two_title,parent_two_first_name,parent_two_last_name,notification_email,notification_enabled
101,Leah,Cohen,1A,Mrs.,Rivka,Cohen,Mr.,Avi,Cohen,rcohen@example.org,true
101,Yosef,Cohen,3B,Mrs.,Rivka,Cohen,Mr.,Avi,Cohen,rcohen@example.org,true
102,Sara,Levy,2A,Ms.,Miriam,Levy,,,,mlevy@example.org,true
103,Moshe,Gold,Kindergarten,Dr.,Aaron,Gold,Dr.,Esther,Gold,,false
```

## Optional Columns

| Column | What it does |
| --- | --- |
| `parent_one_title` | Optional title for the first parent or guardian, such as `Mrs.`, `Mr.`, `Ms.`, `Dr.` |
| `parent_one_first_name` | First parent or guardian first name. |
| `parent_one_last_name` | First parent or guardian last name. |
| `parent_two_title` | Optional title for the second parent or guardian. |
| `parent_two_first_name` | Second parent or guardian first name. |
| `parent_two_last_name` | Second parent or guardian last name. |
| `notification_email` | Email address for pickup permission alerts. Leave blank if the family should not receive email alerts. |
| `notification_enabled` | Use `true` or `false`. Blank is treated as enabled when an email is provided. |
| `grade` | Accepted for review, but not saved into the system. Use `class_name` for the actual classroom assignment. |

If the source roster only has one parent column, the importer can also read `parent_names`. It will try to split two names separated by `&`, `/`, or `and`. The full parent one / parent two columns are preferred because they avoid cleanup after import.

## Rules To Follow

- Put each student on a separate row.
- Use the same `carpool_number` for siblings.
- Keep parent and notification information identical on every row with the same `carpool_number`.
- Use whole numbers only for `carpool_number`. Do not include `#`, letters, decimals, or ranges.
- Do not include the same student more than once with the same `carpool_number`.
- If a value contains a comma, wrap it in quotes. Example: `"Room 3, Morah Stein"`.
- Blank rows are ignored.

## What The Import Does

After upload, the Admin Dashboard shows a preview before anything is saved.

The preview will show whether each row will:

- Create a new class
- Create or update a family
- Create or update a student
- Be rejected until an error is fixed
- Be skipped if the admin unchecks the row

The admin can edit cells in the preview before clicking **Confirm Import**.

## Existing Data

If the uploaded CSV contains a student who already exists under the same family carpool number, the import updates that student if the class or spelling changed.

If the CSV contains a new `class_name` or new `carpool_number`, the system creates it automatically.

If the CSV changes parent names or notification settings for an existing carpool number, the family record is updated.

## Header Names

Use the exact header names in the template when possible. The importer also recognizes common versions such as `First Name`, `Last Name`, `Class`, `Carpool Number`, `Parent 1 First Name`, and `Email`, but the template headers are the safest option.
