-- Ølkartet Oslo — community bars & price reports
-- Run this once in the Supabase SQL editor (see ../supabase_readme.md for
-- the full setup walkthrough: Google OAuth, config values, admin seeding).
--
-- Design: price_reports is an append-only log, never edited in place.
-- "The current price" for a bar is simply its latest non-removed report
-- (see pilsguiden_location_current_prices below). Moderating a liar means
-- soft-deleting their report(s) via the admin_* RPCs; the current-price
-- view then falls back to whatever was valid before automatically — that
-- IS the "revert to previous price" feature, not a separate mechanism.

-- ============================================================
-- Profiles — one row per signed-in user, auto-created on signup
-- ============================================================

create table if not exists pilsguiden_location_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table pilsguiden_location_profiles enable row level security;

-- SECURITY DEFINER so checking admin status doesn't re-trigger RLS on this
-- same table from inside a policy - an inline `exists (select ... from
-- pilsguiden_location_profiles ...)` policy works for an authenticated
-- user checking their own row (the "select own profile" policy below
-- terminates it), but infinitely recurses for an anonymous caller
-- (auth.uid() is null, so neither policy ever resolves). This function
-- runs as its owner (bypassing RLS) and sidesteps that entirely - the
-- standard Supabase pattern for this.
create or replace function pilsguiden_location_is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select coalesce((select is_admin from pilsguiden_location_profiles where id = auth.uid()), false);
$$;

grant execute on function pilsguiden_location_is_admin() to anon, authenticated;

drop policy if exists "select own profile" on pilsguiden_location_profiles;
create policy "select own profile"
  on pilsguiden_location_profiles for select
  using (auth.uid() = id);

drop policy if exists "admins select all profiles" on pilsguiden_location_profiles;
create policy "admins select all profiles"
  on pilsguiden_location_profiles for select
  using (pilsguiden_location_is_admin());

-- No insert/update policy for the authenticated role at all: profile rows
-- are only ever written by the trigger below (new signups) or by you,
-- directly in the SQL editor, to grant is_admin. This is what keeps
-- privilege escalation off the table entirely.

create or replace function pilsguiden_location_handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into pilsguiden_location_profiles (id, email, display_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists pilsguiden_location_on_auth_user_created on auth.users;
create trigger pilsguiden_location_on_auth_user_created
  after insert on auth.users
  for each row execute function pilsguiden_location_handle_new_user();

-- ============================================================
-- Bars — community-submitted bars only. Scraped (pilsguiden) bars stay in
-- data/bars.json and are referenced by their existing numeric id below.
-- ============================================================

create table if not exists pilsguiden_location_bars (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  address text,
  brewery text,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  created_by uuid references pilsguiden_location_profiles(id),
  created_at timestamptz not null default now()
);

-- Safe to re-run on a database created before this column existed.
alter table pilsguiden_location_bars add column if not exists brewery text;

alter table pilsguiden_location_bars enable row level security;

drop policy if exists "anyone can read community bars" on pilsguiden_location_bars;
create policy "anyone can read community bars"
  on pilsguiden_location_bars for select
  using (true);

-- No insert/update/delete policy for direct client writes: bars are only
-- ever created through the add_bar_with_price RPC below, so creation and
-- the first price report happen atomically.

-- ============================================================
-- Price reports — the append-only log
-- ============================================================

create table if not exists pilsguiden_location_price_reports (
  id uuid primary key default gen_random_uuid(),
  scraped_bar_id integer,
  community_bar_id uuid references pilsguiden_location_bars(id),
  user_id uuid not null references pilsguiden_location_profiles(id),
  size_label text not null check (size_label in ('0.25', '0.3', '0.33', '0.35', '0.4', '0.45', '0.5', 'pint', '0.6')),
  raw_price numeric not null check (raw_price > 0 and raw_price < 1000),
  price_per_half_liter numeric not null check (price_per_half_liter > 0 and price_per_half_liter < 2000),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references pilsguiden_location_profiles(id),
  removed_reason text,
  constraint exactly_one_bar_reference check (
    (scraped_bar_id is not null)::int + (community_bar_id is not null)::int = 1
  )
);

-- Safe to re-run against a database created before 0.25/0.3/0.35/0.45/0.6
-- were added to community.js's SIZE_OPTIONS: Postgres names an inline
-- column check constraint "<table>_<column>_check" by default, so this
-- targets and replaces that same auto-generated name.
alter table pilsguiden_location_price_reports drop constraint if exists pilsguiden_location_price_reports_size_label_check;
alter table pilsguiden_location_price_reports add constraint pilsguiden_location_price_reports_size_label_check
  check (size_label in ('0.25', '0.3', '0.33', '0.35', '0.4', '0.45', '0.5', 'pint', '0.6'));

create index if not exists pilsguiden_location_price_reports_scraped_bar_idx
  on pilsguiden_location_price_reports (scraped_bar_id, created_at desc)
  where removed_at is null;

create index if not exists pilsguiden_location_price_reports_community_bar_idx
  on pilsguiden_location_price_reports (community_bar_id, created_at desc)
  where removed_at is null;

create index if not exists pilsguiden_location_price_reports_user_idx
  on pilsguiden_location_price_reports (user_id);

alter table pilsguiden_location_price_reports enable row level security;

drop policy if exists "anyone can read active price reports" on pilsguiden_location_price_reports;
create policy "anyone can read active price reports"
  on pilsguiden_location_price_reports for select
  using (removed_at is null);

drop policy if exists "admins can read all price reports" on pilsguiden_location_price_reports;
create policy "admins can read all price reports"
  on pilsguiden_location_price_reports for select
  using (pilsguiden_location_is_admin());

-- No insert/update/delete policy for the authenticated role: rows are
-- only ever written via submit_price_report / add_bar_with_price, and
-- only ever soft-deleted/restored via the admin_* RPCs. This means a
-- regular user cannot remove or edit even their own submission directly —
-- intentional, since the log needs to stay tamper-evident for moderation.

-- ============================================================
-- Current-price view — latest non-removed report per bar
-- ============================================================

create or replace view pilsguiden_location_current_prices as
select distinct on (coalesce(scraped_bar_id::text, community_bar_id::text))
  scraped_bar_id,
  community_bar_id,
  price_per_half_liter,
  size_label,
  raw_price,
  user_id,
  created_at
from pilsguiden_location_price_reports
where removed_at is null
order by coalesce(scraped_bar_id::text, community_bar_id::text), created_at desc;

grant select on pilsguiden_location_current_prices to anon, authenticated;

-- ============================================================
-- Size -> price-per-0.5L conversion (shared by both insert RPCs)
-- Pint = imperial pint, 0.568L. This is a judgment call — Norwegian bars
-- don't standardize "pint" consistently; change the 0.568 below if you'd
-- rather use the US pint (0.473L).
-- ============================================================

create or replace function pilsguiden_location_price_per_half_liter(size_label text, raw_price numeric)
returns numeric
language sql
immutable
as $$
  select raw_price * 0.5 / case size_label
    when '0.25' then 0.25
    when '0.3' then 0.3
    when '0.33' then 0.33
    when '0.35' then 0.35
    when '0.4' then 0.4
    when '0.45' then 0.45
    when '0.5' then 0.5
    when 'pint' then 0.568
    when '0.6' then 0.6
  end;
$$;

-- ============================================================
-- RPCs — the only way price_reports/bars ever get written or moderated
-- ============================================================

create or replace function pilsguiden_location_submit_price_report(
  p_scraped_bar_id integer,
  p_community_bar_id uuid,
  p_size_label text,
  p_raw_price numeric
)
returns pilsguiden_location_price_reports
language plpgsql
security definer set search_path = public
as $$
declare
  result pilsguiden_location_price_reports;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in to submit a price';
  end if;
  if (p_scraped_bar_id is not null)::int + (p_community_bar_id is not null)::int <> 1 then
    raise exception 'Exactly one of scraped_bar_id / community_bar_id must be set';
  end if;

  insert into pilsguiden_location_price_reports
    (scraped_bar_id, community_bar_id, user_id, size_label, raw_price, price_per_half_liter)
  values (
    p_scraped_bar_id,
    p_community_bar_id,
    auth.uid(),
    p_size_label,
    p_raw_price,
    pilsguiden_location_price_per_half_liter(p_size_label, p_raw_price)
  )
  returning * into result;

  return result;
end;
$$;

grant execute on function pilsguiden_location_submit_price_report(integer, uuid, text, numeric) to authenticated;

-- Signature changed (added p_brewery) after the original 6-arg version
-- shipped, so the old overload is dropped explicitly - "create or replace"
-- only replaces a function with the exact same argument list, otherwise it
-- just adds a second overload and leaves the stale one callable.
drop function if exists pilsguiden_location_add_bar_with_price(text, text, double precision, double precision, text, numeric);

create or replace function pilsguiden_location_add_bar_with_price(
  p_name text,
  p_address text,
  p_brewery text,
  p_lat double precision,
  p_lng double precision,
  p_size_label text,
  p_raw_price numeric
)
returns pilsguiden_location_bars
language plpgsql
security definer set search_path = public
as $$
declare
  new_bar pilsguiden_location_bars;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in to add a bar';
  end if;

  insert into pilsguiden_location_bars (name, address, brewery, lat, lng, created_by)
  values (p_name, p_address, p_brewery, p_lat, p_lng, auth.uid())
  returning * into new_bar;

  insert into pilsguiden_location_price_reports
    (community_bar_id, user_id, size_label, raw_price, price_per_half_liter)
  values (
    new_bar.id,
    auth.uid(),
    p_size_label,
    p_raw_price,
    pilsguiden_location_price_per_half_liter(p_size_label, p_raw_price)
  );

  return new_bar;
end;
$$;

grant execute on function pilsguiden_location_add_bar_with_price(text, text, text, double precision, double precision, text, numeric) to authenticated;

create or replace function pilsguiden_location_assert_admin()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not pilsguiden_location_is_admin() then
    raise exception 'Admin privileges required';
  end if;
end;
$$;

create or replace function pilsguiden_location_admin_remove_report(p_report_id uuid, p_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  perform pilsguiden_location_assert_admin();

  update pilsguiden_location_price_reports
  set removed_at = now(), removed_by = auth.uid(), removed_reason = p_reason
  where id = p_report_id and removed_at is null;
end;
$$;

grant execute on function pilsguiden_location_admin_remove_report(uuid, text) to authenticated;

create or replace function pilsguiden_location_admin_remove_user_reports(p_target_user_id uuid, p_reason text)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  affected integer;
begin
  perform pilsguiden_location_assert_admin();

  update pilsguiden_location_price_reports
  set removed_at = now(), removed_by = auth.uid(), removed_reason = p_reason
  where user_id = p_target_user_id and removed_at is null;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

grant execute on function pilsguiden_location_admin_remove_user_reports(uuid, text) to authenticated;

create or replace function pilsguiden_location_admin_restore_report(p_report_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  perform pilsguiden_location_assert_admin();

  update pilsguiden_location_price_reports
  set removed_at = null, removed_by = null, removed_reason = null
  where id = p_report_id;
end;
$$;

grant execute on function pilsguiden_location_admin_restore_report(uuid) to authenticated;

-- ============================================================
-- Admin read helper — recent reports incl. removed ones, with the
-- reporting user's email, for the in-app admin panel. A view (rather than
-- a raw table select) so the email join doesn't need its own RLS dance.
-- ============================================================

create or replace view pilsguiden_location_admin_report_feed as
select
  r.id,
  r.scraped_bar_id,
  r.community_bar_id,
  b.name as community_bar_name,
  r.user_id,
  p.email as user_email,
  r.size_label,
  r.raw_price,
  r.price_per_half_liter,
  r.created_at,
  r.removed_at,
  r.removed_reason
from pilsguiden_location_price_reports r
left join pilsguiden_location_bars b on b.id = r.community_bar_id
join pilsguiden_location_profiles p on p.id = r.user_id
order by r.created_at desc;

grant select on pilsguiden_location_admin_report_feed to authenticated;
alter view pilsguiden_location_admin_report_feed set (security_invoker = on);

-- security_invoker means this view is still subject to the querying
-- user's own RLS on price_reports (admins see everything, everyone else
-- only sees non-removed rows) — no separate admin check needed here.
