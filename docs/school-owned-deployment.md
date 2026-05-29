# School-Owned Deployment Checklist

Use this when moving the carpool system to school-owned Supabase and Vercel accounts.

## Accounts

- Supabase: create a school-owned account or organization and a new project.
- Vercel: create a school-owned account or team and deploy the project there.
- GitHub: if the school needs long-term control of future deploys, move or mirror the repository into a school-owned GitHub account or organization.
- Resend: keep or create a school-owned Resend account if pickup permission email alerts should continue.

## Supabase Project

1. Create the new Supabase project.
2. In Project Settings, copy:
   - Project URL
   - Project ref
   - Anon public key
3. In the Supabase SQL Editor, run `sql/schema.sql`.
4. Load roster data.
   - For a fresh setup, add classes, families, and students through the admin page after the admin login is created. Use `docs/roster-import-instructions.md` for the roster CSV format.
   - For a migration, export/import at least `classes`, `families`, `students`, `pickup_authorizations`, `pickup_authorization_students`, `carpool_presets`, and `carpool_preset_students`. Do not import `daily_status` unless the current day's live pickup state must be preserved.
5. Create Supabase Auth users for the school staff who need dashboard access.
6. Insert roles for those users:

```sql
insert into public.app_users (id, role)
values
  ('<ADMIN_USER_UUID>', 'admin'),
  ('<SPOTTER_USER_UUID>', 'spotter');
```

## Frontend Config

Update `assets/js/config.js` with the new Supabase project URL and anon public key:

```js
window.CARPOOL_CONFIG = {
  supabaseUrl: "https://<PROJECT_REF>.supabase.co",
  supabaseAnonKey: "<ANON_PUBLIC_KEY>",
  schoolTimezone: "America/New_York"
};
```

The anon key is public browser configuration. Never put the service role key in this file.

## Supabase Edge Functions

Log in with the school-owned Supabase account:

```bash
supabase login
supabase link --project-ref <PROJECT_REF>
supabase functions deploy send-pickup-permission-alert
supabase functions deploy process-scheduled-pickups
```

Set function secrets:

```bash
supabase secrets set RESEND_API_KEY="<RESEND_API_KEY>"
supabase secrets set NOTIFICATION_FROM_EMAIL="TSGW Carpool <carpool@example.org>"
supabase secrets set APP_BASE_URL="https://<VERCEL_DOMAIN>"
supabase secrets set PICKUP_ALERT_WEBHOOK_SECRET="<RANDOM_SHARED_SECRET>"
supabase secrets set SCHEDULED_PICKUP_SECRET="<RANDOM_SHARED_SECRET>"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically to deployed Supabase Edge Functions.

## Pickup Permission Email Webhook

In the Supabase Dashboard, create a Database Webhook:

- Table: `public.pickup_notification_queue`
- Events: `Insert`
- Type: HTTP Request
- Method: `POST`
- URL: `https://<PROJECT_REF>.supabase.co/functions/v1/send-pickup-permission-alert`
- Header: `x-pickup-alert-secret: <PICKUP_ALERT_WEBHOOK_SECRET>`

## Scheduled Pickup Processor

The app needs a frequent scheduled HTTP call for delayed parent pickup requests.

Preferred options:

- Supabase or an external scheduler: call `https://<PROJECT_REF>.supabase.co/functions/v1/process-scheduled-pickups` every minute with header `x-scheduled-pickup-secret: <SCHEDULED_PICKUP_SECRET>`.
- Vercel Pro or Enterprise Cron: call `/api/process-scheduled-pickups` every minute. Vercel Hobby cron is not enough for this because it is limited to daily schedules.

If using Vercel Cron, add these Vercel environment variables:

- `CRON_SECRET`: random string used by Vercel Cron authorization
- `SCHEDULED_PICKUP_FUNCTION_URL`: `https://<PROJECT_REF>.supabase.co/functions/v1/process-scheduled-pickups`
- `SCHEDULED_PICKUP_SECRET`: same value set in Supabase

Then add this to `vercel.json` and redeploy:

```json
{
  "crons": [
    {
      "path": "/api/process-scheduled-pickups",
      "schedule": "* * * * *"
    }
  ]
}
```

Merge it with the existing `rewrites` and `headers` keys rather than replacing the whole file.

## Vercel Deployment

Dashboard path:

1. In the school-owned Vercel account/team, create a new project.
2. Import the school-owned GitHub repository, or deploy from this local checkout.
3. Use the default static deployment settings. There is no build command.
4. Confirm `vercel.json` is included so nested routes like `/classroom/<classId>` work.
5. Add the production domain.

CLI path:

```bash
vercel login
vercel link
vercel --prod
```

Use the school-owned Vercel login or team scope when prompted.

## GitHub Keepalive

The existing GitHub Actions keepalive workflow can keep Supabase active. In the school-owned GitHub repository, add repository secrets:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

## Verification

After deploy:

- Open `/`, `/settings/`, `/classroom/`, `/spotter/`, and `/admin/`.
- Confirm parent lookup works for a real carpool number.
- Confirm spotter and admin users can sign in.
- Confirm classroom display updates when a student is called.
- Trigger a pickup permission change and confirm the notification queue row is processed.
- Create a scheduled pickup for a few minutes ahead and confirm it is called automatically.
