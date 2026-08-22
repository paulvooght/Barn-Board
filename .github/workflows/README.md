# Workflows

## Supabase Keepalive (`keepalive.yml`)

The free Supabase plan auto-pauses a project after about 7 days with no API
activity — that takes the whole app down. This workflow pings the database
every 2 days so it never goes idle, and fails loudly (GitHub emails the repo
owner) if the ping doesn't get a real response, so it also acts as an
early-warning monitor.

It needs two repository secrets to run. To add them:

1. Go to the GitHub repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Add a secret named `SUPABASE_URL` with the project's URL
4. Click **New repository secret** again, add one named `SUPABASE_ANON_KEY`
   with the project's anon key

Both values are in the Supabase dashboard under **Project Settings → API**.
`SUPABASE_URL` also already appears locally as `VITE_SUPABASE_URL` in `.env.local`.

The anon key is the public/publishable key — the same one already shipped in
the browser bundle, so it's safe to store here. **Never** use the
service-role key for this (or put it in the repo/GitHub at all) — it bypasses
all database security rules.
