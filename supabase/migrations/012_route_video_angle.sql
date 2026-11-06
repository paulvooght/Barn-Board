-- ============================================================
-- 012_route_video_angle.sql  —  The board angle a route video was climbed at
--
-- ADDITIVE: adds one nullable column to route_videos, replaces the
-- create_route_video function and adds set_route_video_angle. No existing row
-- changes, and files in the bucket aren't touched. Idempotent. Atomic
-- (begin/commit). Run in the Supabase SQL editor. Verified by
-- scripts/verify_route_videos.mjs.
--
-- Why angle can be null:
--   • Videos uploaded before this change have no angle. The uploader or a wall
--     admin can add one with set_route_video_angle.
--   • p_angle has a default so a phone still running the previous app version
--     (5 arguments) keeps uploading. Every current path sends it, and the app
--     won't let a climber upload without one.
--
-- 0–90 is deliberately wider than The Barn's 18–55: the app's slider holds a
-- wall's real range, and this is only a sanity check that suits any wall.
-- ============================================================

begin;

alter table route_videos add column if not exists angle integer;

alter table route_videos drop constraint if exists route_videos_angle_range;
alter table route_videos add constraint route_videos_angle_range
  check (angle is null or angle between 0 and 90);

-- ── 1. Start an upload: as in 011, plus the angle ────────────────────────────
-- Dropped first because adding an argument would otherwise leave two versions,
-- and a call with 5 arguments couldn't tell which one it meant. Dropping and
-- recreating in one transaction means no call ever finds it missing.
-- The consent wording must match CONSENT_TEXT in src/utils/routeVideos.js.
drop function if exists create_route_video(text, text, bigint, numeric, text);

create or replace function create_route_video(
  p_route_id text, p_mime_type text, p_size_bytes bigint, p_duration_s numeric, p_consent_text text,
  p_angle integer default null
)
returns route_videos
language plpgsql security definer set search_path = public
as $$
declare
  v_board uuid;
  v_id    uuid := gen_random_uuid();
  v_ext   text;
  v       route_videos%rowtype;
begin
  if auth.uid() is null then raise exception 'not_allowed'; end if;

  -- A non-member gets the same answer as a missing route, so this can't be used
  -- to discover routes on walls you can't see. The app retries this error while a
  -- brand-new route is still syncing.
  select r.board_id into v_board from routes r where r.id = p_route_id;
  if v_board is null or not app_is_member(v_board) then
    raise exception 'route_not_found';
  end if;

  if p_consent_text is distinct from 'By uploading I consent to this video being made public to all users of this app' then
    raise exception 'consent_required';
  end if;

  if p_angle is not null and p_angle not between 0 and 90 then
    raise exception 'bad_angle';
  end if;

  v_ext := case p_mime_type
             when 'video/mp4'       then 'mp4'
             when 'video/quicktime' then 'mov'
             when 'video/webm'      then 'webm'
           end;
  if v_ext is null then raise exception 'unsupported_type'; end if;

  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 52428800 then
    raise exception 'file_too_large';
  end if;

  if route_videos_bytes_used() + p_size_bytes > route_videos_cap_bytes() then
    raise exception 'storage_full';
  end if;

  insert into route_videos (id, route_id, board_id, user_id, storage_path, consent_text, mime_type, size_bytes, duration_s, angle)
  values (v_id, p_route_id, v_board, auth.uid(), v_board::text || '/' || v_id::text || '.' || v_ext,
          p_consent_text, p_mime_type, p_size_bytes, p_duration_s, p_angle)
  returning * into v;
  return v;
end;
$$;

-- ── 2. Set or correct the angle: uploader or wall admin ──────────────────────
-- Goes through a function like every other write, because a plain UPDATE policy
-- would also let an uploader flip their own is_public.
create or replace function set_route_video_angle(p_video uuid, p_angle integer)
returns route_videos
language plpgsql security definer set search_path = public
as $$
declare
  v route_videos%rowtype;
begin
  select * into v from route_videos where id = p_video;
  if v.id is null then raise exception 'not_found'; end if;
  -- coalesce: user_id is null once the uploader's account is deleted, and
  -- NOT (NULL OR false) would be NULL, which plpgsql's IF treats as "don't raise".
  if not (coalesce(v.user_id = auth.uid(), false) or app_is_admin(v.board_id)) then
    raise exception 'not_allowed';
  end if;
  if p_angle is null or p_angle not between 0 and 90 then
    raise exception 'bad_angle';
  end if;

  update route_videos
     set angle = p_angle, updated_at = now()
   where id = p_video
  returning * into v;
  return v;
end;
$$;

-- ── Grants ───────────────────────────────────────────────────────────────────
revoke all on function create_route_video(text, text, bigint, numeric, text, integer) from public;
revoke all on function set_route_video_angle(uuid, integer)                           from public;
grant execute on function create_route_video(text, text, bigint, numeric, text, integer) to authenticated;
grant execute on function set_route_video_angle(uuid, integer)                           to authenticated;

notify pgrst, 'reload schema';

commit;

-- ============================================================
-- ROLLBACK (commented out). Puts back the 011 function, then removes the column,
-- which deletes every saved angle. To restore the function, re-run its section
-- from 011_route_videos.sql, including its grant, after these lines.
-- ============================================================
-- drop function if exists set_route_video_angle(uuid, integer);
-- drop function if exists create_route_video(text, text, bigint, numeric, text, integer);
-- alter table route_videos drop constraint if exists route_videos_angle_range;
-- alter table route_videos drop column if exists angle;
