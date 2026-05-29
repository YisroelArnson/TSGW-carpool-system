# TSGW Carpool System (Static + Supabase)

Implementation of `carpool-system-spec.md` using:

- Frontend: plain HTML/CSS/vanilla JS
- Backend: Supabase only (PostgreSQL + Realtime + Auth)
- Hosting: static files
- Supabase client: CDN (`@supabase/supabase-js@2`)

## File Structure

- `/index.html` - Parent check-in page
- `/settings/index.html` - Parent settings page for permissions and saved carpools
- `/tutorial/index.html` - Parent getting started videos and instructions
- `/help/index.html` - Parent help hub
- `/troubleshooting/index.html` - Parent troubleshooting and office question form
- `/faq/index.html` - Parent FAQ
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

For a full school-owned Supabase and Vercel redeployment, use
`/Users/yisroel/Developer/TSGW-carpool-system/docs/school-owned-deployment.md`.

## Supabase Keepalive

The GitHub Actions workflow in `.github/workflows/supabase-keepalive.yml` pings the Supabase REST API twice a week and can also be run manually.

For GitHub, add these repository secrets:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

If those secrets are not configured, the workflow falls back to `assets/js/config.js`.

## Local Run

Serve static files with any static server from repo root.

Example (Python):

```bash
python3 -m http.server 8080
```

Then open:

- `http://localhost:8080/`
- `http://localhost:8080/settings/`
- `http://localhost:8080/tutorial/`
- `http://localhost:8080/help/`
- `http://localhost:8080/troubleshooting/`
- `http://localhost:8080/faq/`
- `http://localhost:8080/classroom/`
- `http://localhost:8080/spotter/`
- `http://localhost:8080/admin/`

## Route Notes for Static Hosting

Classroom display supports:

- `/classroom/` (hub)
- `/classroom/<classId>` (display)
- `/classroom/?classId=<classId>` (display fallback)

If your host does not support folder fallback for nested routes, configure rewrites so `/classroom/*` serves `/classroom/index.html`.

Vercel routing is configured in `/Users/yisroel/Developer/TSGW-carpool-system/vercel.json`.

## Behavior Notes

- Parent flow uses RPC (`get_parent_checkin_context`, `submit_check_in_request`) with no custom backend.
- Parent delayed pickup uses `scheduled_pickup_requests`; the browser creates/cancels rows through RPCs, and a backend job processes due rows.
- Parent location auto call uses `pickup_geofence_settings`; parents must allow browser location access and keep the parent page visible. Screen wake lock is requested when the browser supports it.
- Spotter/admin require Supabase Auth.
- Spotter session is persisted by Supabase in browser storage (`persistSession: true`).
- Classroom hub count updates use status transition deltas to prevent overcount drift.
- School day logic uses America/New_York (`school_today()`).

## Pickup Permission Email Alerts

Permission create, edit, and revoke events write to `pickup_notification_queue`. Deploy the Supabase Edge Function and connect a Database Webhook so pending rows are sent through Resend.

1. Deploy the function:

```bash
supabase functions deploy send-pickup-permission-alert
```

2. Set function secrets:

```bash
supabase secrets set RESEND_API_KEY="<RESEND_API_KEY>"
supabase secrets set NOTIFICATION_FROM_EMAIL="TSGW Carpool <carpool@example.org>"
supabase secrets set APP_BASE_URL="https://your-carpool-site.example"
supabase secrets set PICKUP_ALERT_WEBHOOK_SECRET="<random-shared-secret>"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase in deployed Edge Functions. Set them manually only when serving the function locally.

3. In Supabase Dashboard, create a Database Webhook:
   - Table: `public.pickup_notification_queue`
   - Events: `Insert`
   - Type: HTTP Request
   - Method: `POST`
   - URL: `https://<project-ref>.supabase.co/functions/v1/send-pickup-permission-alert`
   - Header: `x-pickup-alert-secret: <random-shared-secret>`

4. Manual function test after a queue row exists:

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/send-pickup-permission-alert" \
  -H "Content-Type: application/json" \
  -H "x-pickup-alert-secret: <random-shared-secret>" \
  -d '{"queue_id":"<pickup_notification_queue_id>"}'
```

## Office Help Request Form

The `/troubleshooting/` page sends parent questions through the `send-office-help-request` Supabase Edge Function. If the function is not deployed or configured, the page falls back to opening a prefilled email to the office address.

1. Deploy the function:

```bash
supabase functions deploy send-office-help-request
```

2. Set function secrets:

```bash
supabase secrets set RESEND_API_KEY="<RESEND_API_KEY>"
supabase secrets set NOTIFICATION_FROM_EMAIL="TSGW Carpool <carpool@example.org>"
supabase secrets set OFFICE_HELP_EMAIL="info@tsgw.org"
```

## Scheduled Parent Pickup Requests

Deploy the processor Edge Function and call it on a frequent schedule, such as once per minute.

1. Deploy the function:

```bash
supabase functions deploy process-scheduled-pickups
```

2. Set a shared secret:

```bash
supabase secrets set SCHEDULED_PICKUP_SECRET="<random-shared-secret>"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase in deployed Edge Functions.

3. Configure a scheduled HTTP call to:

```text
https://<project-ref>.supabase.co/functions/v1/process-scheduled-pickups
```

Use method `POST` and include either header `x-scheduled-pickup-secret: <random-shared-secret>` or `Authorization: Bearer <random-shared-secret>`.

4. Manual function test:

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/process-scheduled-pickups" \
  -H "Content-Type: application/json" \
  -H "x-scheduled-pickup-secret: <random-shared-secret>" \
  -d '{"limit":25}'
```
