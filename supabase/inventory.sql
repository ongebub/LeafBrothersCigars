-- Leaf Brothers staff inventory count (/inventory).
--
-- Same shape as the shift board, for the same reasons: it lives in the
-- Memberships project, the website holds only the PUBLISHABLE key, and the
-- tables deny anon outright.  The only way in from the website is the
-- inventory_* functions below, and every one of them checks the staff
-- passcode first.  The passcode is stored bcrypt-hashed in inventory.config,
-- never in this repo (which is public), and is set by Aurora with a single
-- update -- see entities/leaf-ankeny/notes.md in the aurora repo.
--
-- Nothing here writes to Square.  Counts sit in inventory.counts until Chris
-- has reviewed them; the apply step runs from Chris's machine, not the site.

create schema if not exists inventory;

create table if not exists inventory.config (
  id              integer primary key default 1 check (id = 1),
  passcode_hash   text not null,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  updated_at      timestamptz not null default now()
);

create table if not exists inventory.counts (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  device_id       text not null,          -- random id kept on the phone; "your own entry"
  scanner         text not null,
  shop            text not null check (shop in ('waukee', 'ankeny')),
  section         text not null,
  barcode         text,                   -- what was scanned or typed, if anything
  how             text not null check (how in ('scan', 'search', 'unknown')),
  item_id         text,
  variation_id    text,
  item_name       text,
  variation_name  text,
  typed_text      text,                   -- what the scanner typed for an unknown barcode
  count           integer not null check (count >= 0 and count <= 100000),
  -- matched           = the scanner confirmed a Square variation
  -- pending           = unknown barcode, Aurora has not looked yet
  -- matched_by_aurora = unknown barcode, one confident catalog match
  -- needs_chris       = unknown barcode, no confident match
  -- resolved          = Chris (or Aurora on his word) settled a needs_chris row
  status          text not null check (status in
                    ('matched', 'pending', 'matched_by_aurora', 'needs_chris', 'resolved')),
  match_note      text,
  has_photo       boolean not null default false,
  is_test         boolean not null default false,
  deleted_at      timestamptz,
  applied_at      timestamptz,
  applied_note    text
);

create index if not exists counts_shop_var on inventory.counts (shop, variation_id);
create index if not exists counts_device on inventory.counts (device_id, created_at desc);

create table if not exists inventory.photos (
  count_id   uuid primary key references inventory.counts(id) on delete cascade,
  data_url   text not null check (length(data_url) < 1500000),
  created_at timestamptz not null default now()
);

alter table inventory.config enable row level security;
alter table inventory.counts enable row level security;
alter table inventory.photos enable row level security;
-- No policies, deliberately.

-- ------------------------------------------------------------- internals

-- Raise unless p_code is the staff passcode.  Twenty wrong codes in a row
-- park the door for ten minutes; the counter resets on a right one.
create or replace function inventory.gate(p_code text)
returns void
language plpgsql
security definer
set search_path = inventory, extensions, pg_temp
as $$
declare
  c inventory.config;
begin
  select * into c from inventory.config where id = 1 for update;
  if not found then
    raise exception 'inventory passcode not set up yet' using errcode = '28000';
  end if;
  if c.locked_until is not null and c.locked_until > now() then
    raise exception 'too many wrong codes -- try again in a few minutes' using errcode = '28000';
  end if;
  if c.passcode_hash = crypt(upper(trim(coalesce(p_code, ''))), c.passcode_hash) then
    if c.failed_attempts <> 0 then
      update inventory.config set failed_attempts = 0, locked_until = null where id = 1;
    end if;
    return;
  end if;
  update inventory.config
     set failed_attempts = c.failed_attempts + 1,
         locked_until = case when c.failed_attempts + 1 >= 20
                             then now() + interval '10 minutes' end
   where id = 1;
  raise exception 'wrong passcode' using errcode = '28000';
end;
$$;

create or replace function inventory.row_json(r inventory.counts)
returns json
language sql
stable
security definer
set search_path = inventory, pg_temp
as $$
  select json_build_object(
    'id', r.id, 'created_at', r.created_at, 'updated_at', r.updated_at,
    'scanner', r.scanner, 'shop', r.shop, 'section', r.section,
    'barcode', r.barcode, 'how', r.how,
    'item_id', r.item_id, 'variation_id', r.variation_id,
    'item_name', r.item_name, 'variation_name', r.variation_name,
    'typed_text', r.typed_text, 'count', r.count, 'status', r.status,
    'match_note', r.match_note, 'has_photo', r.has_photo, 'is_test', r.is_test,
    'applied_at', r.applied_at
  );
$$;

-- ---------------------------------------------------------- public API
-- Reachable with the website's publishable key; every one calls gate().

create or replace function public.inventory_verify(p_code text)
returns json
language plpgsql
security definer
set search_path = inventory, pg_temp
as $$
begin
  perform inventory.gate(p_code);
  return json_build_object('ok', true);
end;
$$;

-- One count.  The website resolves names from Square before it calls this;
-- the database just keeps what it is given, inside the checks above.
create or replace function public.inventory_submit(p_code text, p_entry jsonb)
returns json
language plpgsql
security definer
set search_path = inventory, pg_temp
as $$
declare
  r inventory.counts;
  photo text := nullif(p_entry->>'photo', '');
begin
  perform inventory.gate(p_code);
  if coalesce(trim(p_entry->>'scanner'), '') = '' then
    raise exception 'need your name' using errcode = '22023';
  end if;
  if coalesce(trim(p_entry->>'section'), '') = '' then
    raise exception 'need a section' using errcode = '22023';
  end if;
  if coalesce(p_entry->>'device_id', '') !~ '^[A-Za-z0-9-]{8,64}$' then
    raise exception 'bad device id' using errcode = '22023';
  end if;
  if (p_entry->>'how') = 'unknown' and coalesce(trim(p_entry->>'typed_text'), '') = '' then
    raise exception 'type what the cigar is' using errcode = '22023';
  end if;
  if (p_entry->>'how') in ('scan', 'search') and coalesce(p_entry->>'variation_id', '') = '' then
    raise exception 'no Square item picked' using errcode = '22023';
  end if;

  insert into inventory.counts (device_id, scanner, shop, section, barcode, how,
      item_id, variation_id, item_name, variation_name, typed_text, count,
      status, has_photo, is_test)
  values (p_entry->>'device_id',
          left(trim(p_entry->>'scanner'), 60),
          p_entry->>'shop',
          left(trim(p_entry->>'section'), 80),
          nullif(left(trim(p_entry->>'barcode'), 64), ''),
          p_entry->>'how',
          nullif(p_entry->>'item_id', ''),
          nullif(p_entry->>'variation_id', ''),
          nullif(left(p_entry->>'item_name', 200), ''),
          nullif(left(p_entry->>'variation_name', 200), ''),
          nullif(left(trim(p_entry->>'typed_text'), 300), ''),
          (p_entry->>'count')::integer,
          case when (p_entry->>'how') = 'unknown' then 'pending' else 'matched' end,
          photo is not null,
          coalesce((p_entry->>'is_test')::boolean, false))
  returning * into r;

  if photo is not null then
    if photo !~ '^data:image/(jpeg|png|webp);base64,' then
      raise exception 'photo must be an image' using errcode = '22023';
    end if;
    insert into inventory.photos (count_id, data_url) values (r.id, photo);
  end if;

  return inventory.row_json(r);
end;
$$;

-- Aurora's background match for an unknown barcode.  Only moves a row out of
-- 'pending', once, so it cannot be used to rewrite a confirmed count.
create or replace function public.inventory_set_match(p_code text, p_id uuid, p_match jsonb)
returns json
language plpgsql
security definer
set search_path = inventory, pg_temp
as $$
declare
  r inventory.counts;
begin
  perform inventory.gate(p_code);
  if (p_match->>'status') not in ('matched_by_aurora', 'needs_chris') then
    raise exception 'bad match status' using errcode = '22023';
  end if;
  update inventory.counts
     set status = p_match->>'status',
         item_id = case when p_match->>'status' = 'matched_by_aurora' then p_match->>'item_id' end,
         variation_id = case when p_match->>'status' = 'matched_by_aurora' then p_match->>'variation_id' end,
         item_name = case when p_match->>'status' = 'matched_by_aurora' then p_match->>'item_name' end,
         variation_name = case when p_match->>'status' = 'matched_by_aurora' then p_match->>'variation_name' end,
         match_note = left(p_match->>'note', 500),
         updated_at = now()
   where id = p_id and status = 'pending' and deleted_at is null
  returning * into r;
  if not found then
    raise exception 'nothing pending with that id' using errcode = '22023';
  end if;
  return inventory.row_json(r);
end;
$$;

-- This phone's recent entries, newest first.
create or replace function public.inventory_mine(p_code text, p_device text, p_limit integer)
returns json
language plpgsql
security definer
set search_path = inventory, pg_temp
as $$
begin
  perform inventory.gate(p_code);
  return coalesce((
    select json_agg(inventory.row_json(c) order by c.created_at desc)
      from (select * from inventory.counts
             where device_id = p_device and deleted_at is null
             order by created_at desc
             limit least(greatest(coalesce(p_limit, 20), 1), 50)) c
  ), '[]'::json);
end;
$$;

-- Fix a typo on your own entry: same phone, within 12 hours, not yet applied.
create or replace function public.inventory_edit(p_code text, p_device text, p_id uuid,
                                                 p_count integer, p_section text)
returns json
language plpgsql
security definer
set search_path = inventory, pg_temp
as $$
declare
  r inventory.counts;
begin
  perform inventory.gate(p_code);
  update inventory.counts
     set count = coalesce(p_count, count),
         section = coalesce(nullif(left(trim(p_section), 80), ''), section),
         updated_at = now()
   where id = p_id and device_id = p_device and deleted_at is null
     and applied_at is null and created_at > now() - interval '12 hours'
  returning * into r;
  if not found then
    raise exception 'can only change your own entries from the last 12 hours' using errcode = '42501';
  end if;
  return inventory.row_json(r);
end;
$$;

create or replace function public.inventory_delete(p_code text, p_device text, p_id uuid)
returns json
language plpgsql
security definer
set search_path = inventory, pg_temp
as $$
declare
  r inventory.counts;
begin
  perform inventory.gate(p_code);
  update inventory.counts set deleted_at = now(), updated_at = now()
   where id = p_id and device_id = p_device and deleted_at is null
     and applied_at is null and created_at > now() - interval '12 hours'
  returning * into r;
  if not found then
    raise exception 'can only delete your own entries from the last 12 hours' using errcode = '42501';
  end if;
  return json_build_object('deleted', p_id);
end;
$$;

-- --------------------------------------------------------- Aurora only

-- Every live row, for the review sheet.
create or replace function public.inventory_export(p_include_test boolean)
returns json
language sql
stable
security definer
set search_path = inventory, pg_temp
as $$
  select coalesce(json_agg(inventory.row_json(c) order by c.created_at), '[]'::json)
    from inventory.counts c
   where c.deleted_at is null and (p_include_test or not c.is_test);
$$;

create or replace function public.inventory_photo(p_id uuid)
returns text
language sql
stable
security definer
set search_path = inventory, pg_temp
as $$
  select data_url from inventory.photos where count_id = p_id;
$$;

-- Chris settles a Needs Chris row: which Square variation it really is.
create or replace function public.inventory_resolve(p_id uuid, p_match jsonb)
returns json
language plpgsql
security definer
set search_path = inventory, pg_temp
as $$
declare
  r inventory.counts;
begin
  update inventory.counts
     set status = 'resolved',
         item_id = p_match->>'item_id',
         variation_id = p_match->>'variation_id',
         item_name = p_match->>'item_name',
         variation_name = p_match->>'variation_name',
         match_note = left(coalesce(p_match->>'note', 'resolved by Chris'), 500),
         updated_at = now()
   where id = p_id and deleted_at is null
  returning * into r;
  if not found then
    raise exception 'no such entry' using errcode = '22023';
  end if;
  return inventory.row_json(r);
end;
$$;

-- Stamp rows once their count has gone into Square and been read back.
create or replace function public.inventory_mark_applied(p_ids uuid[], p_note text)
returns json
language sql
security definer
set search_path = inventory, pg_temp
as $$
  with done as (
    update inventory.counts set applied_at = now(), applied_note = left(p_note, 500)
     where id = any(p_ids) and applied_at is null
    returning 1)
  select json_build_object('applied', (select count(*) from done));
$$;

-- Clear out test entries after a test run.
create or replace function public.inventory_purge_test()
returns json
language sql
security definer
set search_path = inventory, pg_temp
as $$
  with gone as (delete from inventory.counts where is_test returning 1)
  select json_build_object('purged', (select count(*) from gone));
$$;

-- --------------------------------------------------------------- grants

revoke all on schema inventory from anon, authenticated;
revoke all on all tables in schema inventory from anon, authenticated;
revoke all on function inventory.gate(text) from public, anon, authenticated;
revoke all on function inventory.row_json(inventory.counts) from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'inventory_verify(text)',
    'inventory_submit(text,jsonb)',
    'inventory_set_match(text,uuid,jsonb)',
    'inventory_mine(text,text,integer)',
    'inventory_edit(text,text,uuid,integer,text)',
    'inventory_delete(text,text,uuid)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;

  foreach f in array array[
    'inventory_export(boolean)',
    'inventory_photo(uuid)',
    'inventory_resolve(uuid,jsonb)',
    'inventory_mark_applied(uuid[],text)',
    'inventory_purge_test()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
