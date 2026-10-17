-- Capability-protected, end-to-end encrypted Excalidraw persistence.
-- Apply to the dedicated excalidraw-cloud project only. No drawing is purged.
-- The browser never sends its encryption key. token_hash is SHA-256 of the
-- domain-separated bearer capability, not that capability or encryption key.
begin;

create schema if not exists excalidraw_private;
revoke all on schema excalidraw_private from public, anon, authenticated;

create table excalidraw_private.scenes (
  kind text not null check (kind in ('rooms', 'shareLinks')),
  id text not null check (id ~ '^[a-f0-9]{20}$'),
  token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  scene_version bigint not null check (scene_version between 0 and 9007199254740991),
  iv bytea,
  ciphertext bytea not null check (octet_length(ciphertext) between 1 and 4194304),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (kind, id),
  check ((kind = 'rooms' and octet_length(iv) = 12 and iv is not null
            and octet_length(ciphertext) >= 16)
      or (kind = 'shareLinks' and iv is null and scene_version = 0 and revision = 1))
);

create table excalidraw_private.files (
  kind text not null,
  scene_id text not null,
  file_id text not null check (file_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  byte_size integer not null check (byte_size between 1 and 4194304),
  created_at timestamptz not null default now(),
  primary key (kind, scene_id, file_id),
  foreign key (kind, scene_id) references excalidraw_private.scenes(kind, id)
);

-- These counters reserve space before writes, including interrupted uploads.
-- No automatic expiry or deletion of drawing/file records is performed.
create table excalidraw_private.budget (
  singleton boolean primary key default true check (singleton),
  scene_bytes bigint not null default 0 check (scene_bytes between 0 and 201326592),
  file_bytes bigint not null default 0 check (file_bytes between 0 and 536870912),
  scene_count integer not null default 0 check (scene_count between 0 and 5000),
  creation_day date not null default (now() at time zone 'utc')::date,
  daily_creations integer not null default 0 check (daily_creations between 0 and 500)
);
insert into excalidraw_private.budget(singleton) values (true);

-- HMAC-SHA256 of a daily domain-separated IP value, never the raw IP.
create table excalidraw_private.creation_rates (
  ip_hash text not null check (ip_hash ~ '^[a-f0-9]{64}$'),
  hour_start timestamptz not null,
  creations integer not null check (creations between 1 and 30),
  primary key (ip_hash, hour_start)
);

alter table excalidraw_private.scenes enable row level security;
alter table excalidraw_private.files enable row level security;
alter table excalidraw_private.budget enable row level security;
alter table excalidraw_private.creation_rates enable row level security;
revoke all on all tables in schema excalidraw_private from public, anon, authenticated, service_role;
-- Deliberately no RLS policies: only the service-only SECURITY DEFINER RPCs
-- below can access these tables, and each data RPC validates the capability.

create function excalidraw_private.equal_hash(a text, b text)
returns boolean language plpgsql immutable strict set search_path = '' as $$
declare
  x bytea;
  y bytea;
  difference integer := 0;
  i integer;
begin
  if a !~ '^[a-f0-9]{64}$' or b !~ '^[a-f0-9]{64}$' then return false; end if;
  x := decode(a, 'hex');
  y := decode(b, 'hex');
  -- Always compare all 32 bytes. Do not use equality/early exit on secrets.
  for i in 0..31 loop
    difference := difference | (get_byte(x, i) # get_byte(y, i));
  end loop;
  return difference = 0;
end;
$$;

create function excalidraw_private.scene_record(s excalidraw_private.scenes)
returns jsonb language sql immutable strict set search_path = '' as $$
  select jsonb_build_object(
    'revision', s.revision, 'sceneVersion', s.scene_version,
    'iv', case when s.iv is null then null else replace(encode(s.iv, 'base64'), E'\n', '') end,
    'ciphertext', replace(encode(s.ciphertext, 'base64'), E'\n', '')
  );
$$;

create function excalidraw_private.validate_payload(
  p_kind text, p_id text, p_token_hash text, p_scene_version bigint,
  p_iv text, p_ciphertext text
) returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_kind is null or p_kind not in ('rooms', 'shareLinks')
    or p_id is null or p_id !~ '^[a-f0-9]{20}$'
    or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or p_scene_version is null or p_scene_version not between 0 and 9007199254740991
    or p_ciphertext is null or length(p_ciphertext) > 5592408
    or length(p_ciphertext) % 4 <> 0 or p_ciphertext !~ '^[A-Za-z0-9+/]*={0,2}$'
    or octet_length(decode(p_ciphertext, 'base64')) not between 1 and 4194304
    or (p_kind = 'rooms' and (p_iv is null or p_iv !~ '^[A-Za-z0-9+/]{16}$'
      or octet_length(decode(p_iv, 'base64')) <> 12
      or octet_length(decode(p_ciphertext, 'base64')) < 16))
    or (p_kind = 'shareLinks' and (p_iv is not null or p_scene_version <> 0))
  then raise exception 'Invalid encrypted payload' using errcode = '22023'; end if;
end;
$$;

create function public.excalidraw_get_scene(p_kind text, p_id text, p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s excalidraw_private.scenes;
begin
  select * into s from excalidraw_private.scenes where kind = p_kind and id = p_id;
  -- A missing scene and a wrong capability have the same externally visible result.
  if not found or not coalesce(excalidraw_private.equal_hash(s.token_hash, p_token_hash), false)
    then return jsonb_build_object('status', 403); end if;
  return jsonb_build_object('status', 200, 'record', excalidraw_private.scene_record(s));
end;
$$;

create function public.excalidraw_create_scene(
  p_kind text, p_id text, p_token_hash text, p_scene_version bigint,
  p_iv text, p_ciphertext text, p_ip_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s excalidraw_private.scenes;
  b excalidraw_private.budget;
  payload bytea;
  current_hour timestamptz := date_trunc('hour', now());
  current_day date := (now() at time zone 'utc')::date;
  hourly_creations integer;
begin
  perform excalidraw_private.validate_payload(p_kind, p_id, p_token_hash, p_scene_version, p_iv, p_ciphertext);
  if p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$'
    then raise exception 'Invalid rate key' using errcode = '22023'; end if;
  -- A durable global row lock serializes claims and budget accounting. The claim,
  -- immutable verifier, initial ciphertext and accounting commit atomically.
  select * into b from excalidraw_private.budget where singleton for update;
  select * into s from excalidraw_private.scenes where kind = p_kind and id = p_id;
  if found then
    if not coalesce(excalidraw_private.equal_hash(s.token_hash, p_token_hash), false)
      then return jsonb_build_object('status', 403); end if;
    return jsonb_build_object('status', 409, 'record', excalidraw_private.scene_record(s));
  end if;
  payload := decode(p_ciphertext, 'base64');
  if b.scene_count >= 5000 or b.scene_bytes + octet_length(payload) > 201326592
    then return jsonb_build_object('status', 507); end if;
  if b.creation_day = current_day and b.daily_creations >= 500
    then return jsonb_build_object('status', 429, 'retryAfter', 3600); end if;
  select creations into hourly_creations from excalidraw_private.creation_rates
    where ip_hash = p_ip_hash and hour_start = current_hour;
  if coalesce(hourly_creations, 0) >= 30
    then return jsonb_build_object('status', 429, 'retryAfter', 3600); end if;

  insert into excalidraw_private.scenes(kind, id, token_hash, scene_version, iv, ciphertext)
    values (p_kind, p_id, p_token_hash, p_scene_version,
      case when p_iv is null then null else decode(p_iv, 'base64') end, payload)
    returning * into s;
  update excalidraw_private.budget set
    scene_bytes = scene_bytes + octet_length(payload), scene_count = scene_count + 1,
    daily_creations = case when creation_day = current_day then daily_creations + 1 else 1 end,
    creation_day = current_day where singleton;
  insert into excalidraw_private.creation_rates(ip_hash, hour_start, creations)
    values (p_ip_hash, current_hour, 1)
    on conflict (ip_hash, hour_start) do update
      set creations = excalidraw_private.creation_rates.creations + 1;
  -- Only expired anonymous rate-limit counters are cleaned, never user content.
  delete from excalidraw_private.creation_rates where hour_start < now() - interval '48 hours';
  return jsonb_build_object('status', 201, 'record', excalidraw_private.scene_record(s));
end;
$$;

create function public.excalidraw_update_room(
  p_id text, p_token_hash text, p_expected_revision bigint,
  p_scene_version bigint, p_iv text, p_ciphertext text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s excalidraw_private.scenes;
  b excalidraw_private.budget;
  payload bytea;
  delta bigint;
begin
  perform excalidraw_private.validate_payload('rooms', p_id, p_token_hash, p_scene_version, p_iv, p_ciphertext);
  if p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    then raise exception 'Invalid revision' using errcode = '22023'; end if;
  select * into b from excalidraw_private.budget where singleton for update;
  select * into s from excalidraw_private.scenes where kind = 'rooms' and id = p_id for update;
  if not found or not coalesce(excalidraw_private.equal_hash(s.token_hash, p_token_hash), false)
    then return jsonb_build_object('status', 403); end if;
  if s.revision <> p_expected_revision then
    return jsonb_build_object('status', 409, 'record', excalidraw_private.scene_record(s));
  end if;
  payload := decode(p_ciphertext, 'base64');
  delta := octet_length(payload) - octet_length(s.ciphertext);
  if b.scene_bytes + delta > 201326592 or s.revision = 9007199254740991
    then return jsonb_build_object('status', 507); end if;
  -- scene_version is informative, not conflict resolution. Equal or lower
  -- versions may still contain independent edits; the client must reconcile.
  update excalidraw_private.scenes set
    scene_version = p_scene_version, iv = decode(p_iv, 'base64'), ciphertext = payload,
    revision = revision + 1, updated_at = now()
    where kind = 'rooms' and id = p_id returning * into s;
  update excalidraw_private.budget set scene_bytes = scene_bytes + delta where singleton;
  return jsonb_build_object('status', 200, 'record', excalidraw_private.scene_record(s));
end;
$$;

create function public.excalidraw_reserve_file(
  p_kind text, p_id text, p_token_hash text, p_file_id text, p_byte_size integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s excalidraw_private.scenes;
  b excalidraw_private.budget;
  existing_size integer;
  scope_bytes bigint;
  scope_count bigint;
begin
  if p_file_id is null or p_file_id !~ '^[A-Za-z0-9_-]{1,128}$'
    or p_byte_size is null or p_byte_size not between 1 and 4194304
    then raise exception 'Invalid encrypted file' using errcode = '22023'; end if;
  select * into b from excalidraw_private.budget where singleton for update;
  select * into s from excalidraw_private.scenes where kind = p_kind and id = p_id;
  if not found or not coalesce(excalidraw_private.equal_hash(s.token_hash, p_token_hash), false)
    then return jsonb_build_object('status', 403); end if;
  select byte_size into existing_size from excalidraw_private.files
    where kind = p_kind and scene_id = p_id and file_id = p_file_id;
  if found then
    if existing_size <> p_byte_size then return jsonb_build_object('status', 409); end if;
    return jsonb_build_object('status', 200);
  end if;
  select count(*), coalesce(sum(byte_size), 0) into scope_count, scope_bytes
    from excalidraw_private.files where kind = p_kind and scene_id = p_id;
  if scope_count >= 256 or scope_bytes + p_byte_size > 134217728
    or b.file_bytes + p_byte_size > 536870912
    then return jsonb_build_object('status', 507); end if;
  insert into excalidraw_private.files(kind, scene_id, file_id, byte_size)
    values (p_kind, p_id, p_file_id, p_byte_size);
  update excalidraw_private.budget set file_bytes = file_bytes + p_byte_size where singleton;
  return jsonb_build_object('status', 201);
end;
$$;

-- Use a lightweight auth check for file requests, avoiding returning scene bytes.
create function public.excalidraw_authorize_file(
  p_kind text, p_id text, p_token_hash text, p_file_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare s excalidraw_private.scenes; n integer;
begin
  select * into s from excalidraw_private.scenes where kind = p_kind and id = p_id;
  if not found or not coalesce(excalidraw_private.equal_hash(s.token_hash, p_token_hash), false)
    then return jsonb_build_object('status', 403); end if;
  select byte_size into n from excalidraw_private.files
    where kind = p_kind and scene_id = p_id and file_id = p_file_id;
  if not found then return jsonb_build_object('status', 404); end if;
  return jsonb_build_object('status', 200, 'byteSize', n);
end;
$$;

revoke all on all functions in schema excalidraw_private from public, anon, authenticated, service_role;
revoke all on function public.excalidraw_get_scene(text, text, text) from public, anon, authenticated;
revoke all on function public.excalidraw_create_scene(text, text, text, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.excalidraw_update_room(text, text, bigint, bigint, text, text) from public, anon, authenticated;
revoke all on function public.excalidraw_reserve_file(text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.excalidraw_authorize_file(text, text, text, text) from public, anon, authenticated;
grant execute on function public.excalidraw_get_scene(text, text, text) to service_role;
grant execute on function public.excalidraw_create_scene(text, text, text, bigint, text, text, text) to service_role;
grant execute on function public.excalidraw_update_room(text, text, bigint, bigint, text, text) to service_role;
grant execute on function public.excalidraw_reserve_file(text, text, text, text, integer) to service_role;
grant execute on function public.excalidraw_authorize_file(text, text, text, text) to service_role;

-- No storage.objects policies are added. Direct public/anon/authenticated access
-- remains denied. Only the capability-gated Edge Function uses the service role.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
  values ('excalidraw-encrypted', 'excalidraw-encrypted', false, 4194304, array['application/octet-stream']);

commit;
