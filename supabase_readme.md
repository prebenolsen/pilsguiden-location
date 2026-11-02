# Community layer setup (Google login, user-submitted prices, moderation)

One-time setup for the Supabase project backing the "add a bar" / "submit
a price" / admin moderation features. The frontend code (`community.js`,
the new UI in `index.html`/`app.js`) is already wired up — this is just
the Supabase + Google Cloud side.

## 1. Run the schema

Supabase dashboard → SQL Editor → paste the contents of
`supabase/schema.sql` → Run. This creates all `pilsguiden_location_*`
tables, views, RLS policies, and RPC functions. Safe to re-run (uses
`create or replace` / `if not exists` throughout).

## 2. Create a Google OAuth client

Google Cloud Console → APIs & Services → Credentials → Create Credentials
→ OAuth client ID → Web application.

Two separate fields, easy to mix up (this tripped us up once already):

- **Authorized JavaScript origins** — scheme + host only, no path, no
  trailing slash:
  `https://<your-project-ref>.supabase.co`
- **Authorized redirect URIs** — the full callback path goes here
  instead:
  `https://<your-project-ref>.supabase.co/auth/v1/callback`

Copy the generated Client ID and Client Secret.

## 3. Enable Google in Supabase Auth

Supabase dashboard → Authentication → Providers → Google → toggle on,
paste the Client ID/Secret from step 2, Save.

## 4. Set Auth URLs

Supabase dashboard → Authentication → URL Configuration:

- **Site URL**: your Cloudflare Pages URL (e.g.
  `https://pilsguiden-location.pages.dev`)
- **Redirect URLs**: add both your Cloudflare Pages URL and
  `http://localhost:8080` (for `npm run serve` during local dev) — the
  frontend passes `redirectTo: window.location.href`, so whatever origin
  the user signed in from needs to be allow-listed here.

## 5. Connect the frontend

`supabase-config.js` already has this project's URL and anon public key
filled in. If you ever point this at a different Supabase project, update
those two values (Settings → API in the dashboard). The anon key is meant
to be public — it's what ships in the browser bundle — access control is
enforced by the RLS policies in `supabase/schema.sql`, not by hiding this
key.

## 6. Seed the admin

Run once, in the SQL Editor, **after** the admin account has signed in to
the app at least once (so its profile row exists via the
`pilsguiden_location_handle_new_user` trigger):

```sql
update pilsguiden_location_profiles
set is_admin = true
where email = 'prebenolsen90@hotmail.com';
```

Signed-in admins see an "🛡 Admin" section at the bottom of the side
panel, with every price report (including removed ones) and buttons to
remove one report, remove *all* reports from a given user (for a user
who's been lying about prices), and restore a removed report.

## 7. Smoke test

1. `npm run serve`, open `http://localhost:8080`.
2. Sign in with Google.
3. Click "➕ Legg til utested", place the pin (drag it, use "Bruk min
   posisjon", or type an address and click "Finn på kart"), fill in a
   name + size + price, save. Confirm the new bar appears on the map with
   the 👥 community badge.
4. Open any bar's popup, click "💶 Meld inn pris", submit a price in a
   different size. Confirm the displayed price-per-0,5L updates and
   matches the conversion in `supabase/schema.sql`
   (`pilsguiden_location_price_per_half_liter`).
5. Sign in as the admin account, open the Admin panel, remove the test
   submission(s) from step 3/4, confirm the bar/price reverts (or
   disappears if it had no earlier price).

## Notes / judgment calls worth knowing about

- **"Pint" = imperial pint (0.568 L).** Norwegian bars don't standardize
  "pint" consistently; change the `0.568` in
  `pilsguiden_location_price_per_half_liter` (schema.sql) if you'd rather
  use the US pint (0.473 L).
- **Moderation is append-only.** Nothing is ever edited in place — "the
  current price" is just the latest non-removed submission. Removing a
  report doesn't delete history, it just stops counting toward "current,"
  which is also what makes "revert to previous price" free: remove the
  bad one and the previous one is already there.
- **A community bar can end up with zero prices** if every submission for
  it gets removed — it just stops appearing on the map rather than being
  deleted outright (the bar row itself still exists if you want to
  re-attach a corrected price to it later via the SQL editor).
