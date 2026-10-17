-- Deploy the compatible Edge Function before applying this migration.
-- Small successful-write acknowledgements release the accounting row lock
-- before scene-sized response transfer. GET/conflict responses, permissions,
-- capability checks, quotas, and stored drawings remain unchanged.
begin;

create or replace function public.excalidraw_create_scene(
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
  return jsonb_build_object('status', 201, 'writeAck', jsonb_build_object('revision', s.revision, 'sceneVersion', s.scene_version));
end;
$$;

create or replace function public.excalidraw_update_room(
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
  return jsonb_build_object('status', 200, 'writeAck', jsonb_build_object('revision', s.revision, 'sceneVersion', s.scene_version));
end;
$$;

commit;
