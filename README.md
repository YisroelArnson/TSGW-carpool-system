# TSGW Carpool System (Static + Supabase)

Implementation of `carpool-system-spec.md` using:

- Frontend: plain HTML/CSS/vanilla JS
- Backend: Supabase only (PostgreSQL + Realtime + Auth)
- Hosting: static files
- Supabase client: CDN (`@supabase/supabase-js@2`)

## File Structure

- `/index.html` - Parent check-in page
- `/classroom/index.html` - Classroom hub and classroom display page
- `/spotter/index.html` - Spotter dashboard (authenticated)
- `/admin/index.html` - Admin dashboard (authenticated)
- `/assets/css/styles.css` - Shared styles
- `/assets/js/*.js` - Shared/page-specific scripts
- `/sql/schema.sql` - Supabase schema, RLS, RPC, functions

## Setup

1. In Supabase SQL Editor, run:
   - `/Users/yisroel/Developer/TSGW-carpool-system/sql/schema.sql`
2. Create at least one auth user in Supabase Auth.
3. Insert app roles into `app_users`:

```sql
insert into public.app_users (id, role)
values
  ('<ADMIN_USER_UUID>', 'admin'),
  ('<SPOTTER_USER_UUID>', 'spotter');
```

4. Configure client keys:
   - Edit `/Users/yisroel/Developer/TSGW-carpool-system/assets/js/config.js`
   - Set `supabaseUrl` and `supabaseAnonKey`

## Local Run

Serve static files with any static server from repo root.

Example (Python):

```bash
python3 -m http.server 8080
```

Then open:

- `http://localhost:8080/`
- `http://localhost:8080/classroom/`
- `http://localhost:8080/spotter/`
- `http://localhost:8080/admin/`

## Route Notes for Static Hosting

Classroom display supports:

- `/classroom/` (hub)
- `/classroom/<classId>` (display)
- `/classroom/?classId=<classId>` (display fallback)

If your host does not support folder fallback for nested routes, configure rewrites so `/classroom/*` serves `/classroom/index.html`.

## Behavior Notes

- Parent flow uses RPC (`get_family_students`, `submit_parent_check_in`) with no custom backend.
- Spotter/admin require Supabase Auth.
- Spotter session is persisted by Supabase in browser storage (`persistSession: true`).
- Classroom hub count updates use status transition deltas to prevent overcount drift.
- School day logic uses America/New_York (`school_today()`).
