-- Leaf Brothers shift-trade board.
--
-- Lives in the Memberships project because a Supabase project of its own is
-- $10/month and Chris declined that on 2026-09-20.  Sharing the project is
-- only safe because nothing here is reachable with the key the website holds:
-- the tables deny anon outright, and the only way in is the shift_* functions
-- below, each of which needs a session token that shift_login issues against
-- a bcrypt PIN.  public.members has no anon policy either, so a bug in the
-- website cannot walk from a shift trade to a member record.

create schema if not exists shiftboard;

-- ---------------------------------------------------------------- tables

create table if not exists shiftboard.staff (
  id              uuid primary key default gen_random_uuid(),
  display_name    text not null,
  shops           text[] not null,
  pin_hash        text,                         -- null until they enrol
  is_admin        boolean not null default false,
  active          boolean not null default true,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);

-- One join code per shop, told to staff out loud.  Hashed, because a code
-- readable in the database is a code readable by anyone who gets this far.
create table if not exists shiftboard.config (
  shop           text primary key,
  join_code_hash text not null,
  updated_at     timestamptz not null default now()
);

create table if not exists shiftboard.trades (
  id               uuid primary key default gen_random_uuid(),
  shop             text not null check (shop in ('waukee', 'ankeny')),
  shift_date       date not null,
  start_time       time,
  end_time         time,
  note             text,
  posted_by        uuid not null references shiftboard.staff(id),
  claimed_by       uuid references shiftboard.staff(id),
  status           text not null default 'open'
                     check (status in ('open', 'covered', 'cancelled')),
  created_at       timestamptz not null default now(),
  claimed_at       timestamptz,
  -- Aurora polls these from Chris's machine and texts him.  A flag per event
  -- rather than a timestamp comparison, so a slow poll never double-sends.
  notified_posted  boolean not null default false,
  notified_claimed boolean not null default false
);

create index if not exists trades_shop_date on shiftboard.trades (shop, shift_date);

create table if not exists shiftboard.sessions (
  token_hash text primary key,
  staff_id   uuid not null references shiftboard.staff(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table shiftboard.staff    enable row level security;
alter table shiftboard.config   enable row level security;
alter table shiftboard.trades   enable row level security;
alter table shiftboard.sessions enable row level security;
-- No policies, deliberately.  Nothing reaches these tables except the
-- SECURITY DEFINER functions below.

-- ------------------------------------------------------------- internals

-- Resolve a session token to a staff row, or raise.  Every function that acts
-- on someone's behalf goes through here, so a caller holding only the
-- website's publishable key can do nothing at all.
create or replace function shiftboard.whoami(p_token text)
returns shiftboard.staff
language plpgsql
security definer
set search_path = shiftboard, extensions, pg_temp
as $$
declare
  s shiftboard.staff;
begin
  select st.* into s
    from shiftboard.sessions se
    join shiftboard.staff st on st.id = se.staff_id
   where se.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and se.expires_at > now()
     and st.active;
  if not found then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  return s;
end;
$$;

create or replace function shiftboard.new_session(p_staff_id uuid)
returns text
language plpgsql
security definer
set search_path = shiftboard, extensions, pg_temp
as $$
declare
  tok text := encode(gen_random_bytes(32), 'hex');
begin
  delete from shiftboard.sessions where expires_at < now();
  insert into shiftboard.sessions (token_hash, staff_id, expires_at)
  values (encode(digest(tok, 'sha256'), 'hex'), p_staff_id, now() + interval '60 days');
  return tok;
end;
$$;

-- A trade as the app renders it.  Names, never ids, and never a PIN.
create or replace function shiftboard.trade_json(t shiftboard.trades)
returns json
language sql
stable
security definer
set search_path = shiftboard, pg_temp
as $$
  select json_build_object(
    'id', t.id,
    'shop', t.shop,
    'date', t.shift_date,
    'start', t.start_time,
    'end', t.end_time,
    'note', t.note,
    'status', t.status,
    'posted_by', (select display_name from shiftboard.staff where id = t.posted_by),
    'posted_by_id', t.posted_by,
    'claimed_by', (select display_name from shiftboard.staff where id = t.claimed_by),
    'claimed_by_id', t.claimed_by,
    'claimed_at', t.claimed_at
  );
$$;

-- ---------------------------------------------------------- public API

-- Who can sign in at this shop, and whether they have set a PIN yet.
-- Names only: this is the one call that answers before anyone is signed in.
create or replace function public.shift_roster(p_shop text)
returns json
language sql
stable
security definer
set search_path = shiftboard, pg_temp
as $$
  select coalesce(json_agg(json_build_object(
           'id', id, 'name', display_name, 'enrolled', pin_hash is not null
         ) order by display_name), '[]'::json)
    from shiftboard.staff
   where active and p_shop = any(shops);
$$;

-- First time in: prove you know the shop's join code, then set your own PIN.
create or replace function public.shift_enroll(p_staff_id uuid, p_shop text,
                                               p_join_code text, p_pin text)
returns json
language plpgsql
security definer
set search_path = shiftboard, extensions, pg_temp
as $$
declare
  s shiftboard.staff;
  ok boolean;
begin
  if p_pin !~ '^[0-9]{4}$' then
    raise exception 'PIN must be 4 digits' using errcode = '22023';
  end if;

  select * into s from shiftboard.staff
   where id = p_staff_id and active and p_shop = any(shops);
  if not found then
    raise exception 'no such person at that shop' using errcode = '22023';
  end if;
  if s.pin_hash is not null then
    raise exception 'already set up -- sign in with your PIN, or ask Chris to reset it'
      using errcode = '22023';
  end if;

  select c.join_code_hash = crypt(coalesce(p_join_code, ''), c.join_code_hash)
    into ok from shiftboard.config c where c.shop = p_shop;
  if not coalesce(ok, false) then
    raise exception 'wrong join code' using errcode = '28000';
  end if;

  update shiftboard.staff
     set pin_hash = crypt(p_pin, gen_salt('bf')),
         failed_attempts = 0, locked_until = null
   where id = p_staff_id;

  return json_build_object(
    'token', shiftboard.new_session(p_staff_id),
    'me', json_build_object('id', s.id, 'name', s.display_name,
                            'shops', s.shops, 'is_admin', s.is_admin));
end;
$$;

-- Name plus PIN.  Five wrong PINs parks the account for fifteen minutes; a
-- 4-digit PIN is ten thousand guesses otherwise, which is an afternoon.
create or replace function public.shift_login(p_staff_id uuid, p_pin text)
returns json
language plpgsql
security definer
set search_path = shiftboard, extensions, pg_temp
as $$
declare
  s shiftboard.staff;
begin
  select * into s from shiftboard.staff where id = p_staff_id and active;
  if not found or s.pin_hash is null then
    raise exception 'wrong PIN' using errcode = '28000';
  end if;
  if s.locked_until is not null and s.locked_until > now() then
    raise exception 'too many tries -- wait a few minutes' using errcode = '28000';
  end if;

  if s.pin_hash <> crypt(coalesce(p_pin, ''), s.pin_hash) then
    update shiftboard.staff
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 5
                               then now() + interval '15 minutes' end
     where id = s.id;
    raise exception 'wrong PIN' using errcode = '28000';
  end if;

  update shiftboard.staff set failed_attempts = 0, locked_until = null where id = s.id;

  return json_build_object(
    'token', shiftboard.new_session(s.id),
    'me', json_build_object('id', s.id, 'name', s.display_name,
                            'shops', s.shops, 'is_admin', s.is_admin));
end;
$$;

create or replace function public.shift_signout(p_token text)
returns json
language sql
security definer
set search_path = shiftboard, extensions, pg_temp
as $$
  with gone as (
    delete from shiftboard.sessions
     where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
    returning 1)
  select json_build_object('ok', true);
$$;

-- The board: everything at the shops you work, from today forward.  An admin
-- sees both shops whatever their own shops say.
create or replace function public.shift_board(p_token text)
returns json
language plpgsql
security definer
set search_path = shiftboard, pg_temp
as $$
declare
  me shiftboard.staff := shiftboard.whoami(p_token);
begin
  return json_build_object(
    'me', json_build_object('id', me.id, 'name', me.display_name,
                            'shops', me.shops, 'is_admin', me.is_admin),
    'needs_covered', (
      select coalesce(json_agg(shiftboard.trade_json(t)
               order by t.shift_date, t.start_time), '[]'::json)
        from shiftboard.trades t
       where t.status = 'open'
         and t.shift_date >= (now() at time zone 'America/Chicago')::date
         and (me.is_admin or t.shop = any(me.shops))),
    'covered', (
      select coalesce(json_agg(shiftboard.trade_json(t)
               order by t.shift_date, t.start_time), '[]'::json)
        from shiftboard.trades t
       where t.status = 'covered'
         and t.shift_date >= (now() at time zone 'America/Chicago')::date
         and (me.is_admin or t.shop = any(me.shops))));
end;
$$;

create or replace function public.shift_post(p_token text, p_shop text,
                                             p_date date, p_start time,
                                             p_end time, p_note text)
returns json
language plpgsql
security definer
set search_path = shiftboard, pg_temp
as $$
declare
  me shiftboard.staff := shiftboard.whoami(p_token);
  t  shiftboard.trades;
begin
  if not (me.is_admin or p_shop = any(me.shops)) then
    raise exception 'that is not your shop' using errcode = '42501';
  end if;
  if p_date < (now() at time zone 'America/Chicago')::date then
    raise exception 'that date has already been and gone' using errcode = '22023';
  end if;

  insert into shiftboard.trades (shop, shift_date, start_time, end_time, note, posted_by)
  values (p_shop, p_date, p_start, p_end, nullif(btrim(coalesce(p_note, '')), ''), me.id)
  returning * into t;

  return shiftboard.trade_json(t);
end;
$$;

create or replace function public.shift_claim(p_token text, p_trade_id uuid)
returns json
language plpgsql
security definer
set search_path = shiftboard, pg_temp
as $$
declare
  me shiftboard.staff := shiftboard.whoami(p_token);
  t  shiftboard.trades;
begin
  -- Locked, so two people tapping at once cannot both get it.
  select * into t from shiftboard.trades where id = p_trade_id for update;
  if not found then
    raise exception 'that shift is gone' using errcode = '22023';
  end if;
  if t.status <> 'open' then
    raise exception 'somebody already picked that one up' using errcode = '22023';
  end if;
  if not (me.is_admin or t.shop = any(me.shops)) then
    raise exception 'that is not your shop' using errcode = '42501';
  end if;
  if t.posted_by = me.id then
    raise exception 'that is your own shift' using errcode = '22023';
  end if;

  update shiftboard.trades
     set status = 'covered', claimed_by = me.id, claimed_at = now(),
         notified_claimed = false
   where id = t.id
  returning * into t;

  return shiftboard.trade_json(t);
end;
$$;

-- Back on the board.  Whoever took it can hand it back, and so can Chris.
create or replace function public.shift_unclaim(p_token text, p_trade_id uuid)
returns json
language plpgsql
security definer
set search_path = shiftboard, pg_temp
as $$
declare
  me shiftboard.staff := shiftboard.whoami(p_token);
  t  shiftboard.trades;
begin
  select * into t from shiftboard.trades where id = p_trade_id for update;
  if not found or t.status <> 'covered' then
    raise exception 'that shift is not covered' using errcode = '22023';
  end if;
  if not (me.is_admin or t.claimed_by = me.id) then
    raise exception 'that is not yours to give back' using errcode = '42501';
  end if;

  update shiftboard.trades
     set status = 'open', claimed_by = null, claimed_at = null
   where id = t.id
  returning * into t;

  return shiftboard.trade_json(t);
end;
$$;

-- The poster changed their mind, or Chris is tidying up.
create or replace function public.shift_cancel(p_token text, p_trade_id uuid)
returns json
language plpgsql
security definer
set search_path = shiftboard, pg_temp
as $$
declare
  me shiftboard.staff := shiftboard.whoami(p_token);
  t  shiftboard.trades;
begin
  select * into t from shiftboard.trades where id = p_trade_id for update;
  if not found then
    raise exception 'that shift is gone' using errcode = '22023';
  end if;
  if not (me.is_admin or t.posted_by = me.id) then
    raise exception 'that is not your shift' using errcode = '42501';
  end if;

  update shiftboard.trades set status = 'cancelled' where id = t.id
  returning * into t;
  return shiftboard.trade_json(t);
end;
$$;

-- Chris only: forget somebody's PIN so they can enrol again with the join code.
create or replace function public.shift_reset_pin(p_token text, p_staff_id uuid)
returns json
language plpgsql
security definer
set search_path = shiftboard, pg_temp
as $$
declare
  me shiftboard.staff := shiftboard.whoami(p_token);
begin
  if not me.is_admin then
    raise exception 'admins only' using errcode = '42501';
  end if;
  update shiftboard.staff
     set pin_hash = null, failed_attempts = 0, locked_until = null
   where id = p_staff_id;
  delete from shiftboard.sessions where staff_id = p_staff_id;
  return json_build_object('ok', true);
end;
$$;

-- ------------------------------------------------------- the notifier
--
-- Chris's machine polls these with the project's secret key and sends him a
-- Telegram.  They live here rather than in a Vercel function so the Telegram
-- bot token never has to exist on the website's side.  service_role only --
-- the website's key cannot call them.

create or replace function public.shift_notices()
returns json
language sql
security definer
set search_path = shiftboard, pg_temp
as $$
  select coalesce(json_agg(json_build_object(
           'id', t.id,
           'kind', k.kind,
           'shop', t.shop,
           'date', t.shift_date,
           'start', t.start_time,
           'end', t.end_time,
           'note', t.note,
           'posted_by', (select display_name from shiftboard.staff where id = t.posted_by),
           'claimed_by', (select display_name from shiftboard.staff where id = t.claimed_by)
         ) order by t.created_at), '[]'::json)
    from shiftboard.trades t
    cross join lateral (values
        ('posted',  not t.notified_posted),
        ('claimed', t.status = 'covered' and not t.notified_claimed)
      ) as k(kind, due)
   where k.due and t.status <> 'cancelled';
$$;

-- Marked only once the Telegram actually went, so a failed send re-sends
-- rather than going quiet -- the same rule as the bill reminders.
create or replace function public.shift_notices_ack(p_ids uuid[], p_kind text)
returns json
language sql
security definer
set search_path = shiftboard, pg_temp
as $$
  with done as (
    update shiftboard.trades
       set notified_posted  = notified_posted  or p_kind = 'posted',
           notified_claimed = notified_claimed or p_kind = 'claimed'
     where id = any(p_ids)
    returning 1)
  select json_build_object('acked', (select count(*) from done));
$$;

-- --------------------------------------------------------------- grants
--
-- Named one at a time rather than matched with a pattern: the roster call and
-- the notifier call both begin "shift_", and exactly one of them may be
-- reachable with the website's publishable key.  A pattern would have handed
-- the internet the notifier the day it was added.

revoke all on schema shiftboard from anon, authenticated;

do $$
declare f text;
begin
  -- Reachable by the website, i.e. by anyone. Each one still demands either a
  -- PIN or a session token that a PIN issued.
  foreach f in array array[
    'shift_roster(text)',
    'shift_enroll(uuid,text,text,text)',
    'shift_login(uuid,text)',
    'shift_signout(text)',
    'shift_board(text)',
    'shift_post(text,text,date,time without time zone,time without time zone,text)',
    'shift_claim(text,uuid)',
    'shift_unclaim(text,uuid)',
    'shift_cancel(text,uuid)',
    'shift_reset_pin(text,uuid)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;

  -- Aurora only.
  foreach f in array array[
    'shift_notices()',
    'shift_notices_ack(uuid[],text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
