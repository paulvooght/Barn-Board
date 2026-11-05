-- ============================================================
-- 011_route_videos.sql  —  Uploaded route videos
--
-- ADDITIVE: adds one table, one PRIVATE storage bucket, helper functions and
-- storage policies. Touches no existing table or row. Idempotent. Atomic
-- (begin/commit), so an error part-way applies nothing. Run in the Supabase SQL
-- editor. Verified by scripts/verify_route_videos.mjs.
--
-- Model (owner decisions 2026-11-05):
--   • Any member of a wall can add a video to a route on that wall.
--   • A new video is visible ONLY to its uploader and that wall's admins
--     (board_members.role = 'admin', NOT the global profiles.is_admin).
--   • A wall admin can make a video public to that wall's members, and undo it.
--   • Uploaders can delete their own videos; wall admins can delete any.
--   • A video outlives its route row only until it is cleaned up. A non-admin
--     setter can't remove other people's private files, so those wait for the
--     admin clean-up (list_orphan_route_videos).
--
-- Why everything writes through functions: RLS is per ROW, so a plain UPDATE
-- policy would let an uploader flip their own is_public. The table is read-only
-- to clients and every write goes through a SECURITY DEFINER function that
-- re-checks permissions (same pattern as 007).
--
-- Upload order: create_route_video (row, status 'uploading') → upload the file
-- (the storage policy requires that row) → finish_route_video (status 'ready').
-- Delete order: remove the file via the Storage API → delete_route_video_row.
-- Deleting storage.objects with SQL would orphan the file in the bucket.
-- ============================================================

begin;

-- ── Table ────────────────────────────────────────────────────────────────────
create table if not exists route_videos (
  id            uuid primary key default gen_random_uuid(),
  route_id      text not null,                        -- routes.id (no FK: see delete notes above)
  board_id      uuid not null references boards(id),  -- copied from the route, never from the client
  user_id       uuid references auth.users(id) on delete set null,  -- row survives so an admin can still remove the file
  storage_path  text not null unique,                 -- <board_id>/<id>.<ext>
  status        text not null default 'uploading' check (status in ('uploading', 'ready')),
  is_public     boolean not null default false,
  published_at  timestamptz,
  published_by  uuid,
  consent_text  text not null,
  consented_at  timestamptz not null default now(),
  mime_type     text not null,
  size_bytes    bigint,
  duration_s    numeric,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint route_videos_public_needs_ready check (status = 'ready' or is_public = false)
);

create index if not exists route_videos_route_id_idx on route_videos (route_id);
create index if not exists route_videos_board_id_idx on route_videos (board_id);

alter table route_videos enable row level security;

drop policy if exists "route_videos: read" on route_videos;
create policy "route_videos: read" on route_videos for select to authenticated
  using (
    user_id = auth.uid()
    or app_is_admin(board_id)
    or (is_public and app_is_member(board_id))
  );

-- No insert/update/delete policies, and the grants are gone too: writes go
-- through the functions below only.
revoke insert, update, delete on route_videos from anon, authenticated;

-- ── Bucket: PRIVATE, 50 MB per file (the Free plan's maximum) ────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('route-videos', 'route-videos', false, 52428800,
        array['video/mp4', 'video/quicktime', 'video/webm'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── Storage quota guard ──────────────────────────────────────────────────────
-- Going over the Free plan's 1 GB can restrict the WHOLE project, not just
-- videos, so uploads stop at 800 MB. Change the number here to raise it.
create or replace function route_videos_cap_bytes()
returns bigint language sql immutable as $$ select 838860800::bigint $$;

create or replace function route_videos_bytes_used()
returns bigint language sql security definer stable set search_path = public as $$
  select coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint
    from storage.objects o
   where o.bucket_id = 'route-videos';
$$;

-- ── Storage policy helpers ───────────────────────────────────────────────────
-- SECURITY DEFINER so a policy can look at the row without tripping route_videos
-- RLS; auth.uid() is still the caller.
create or replace function app_can_read_video_object(p_name text)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from route_videos v
     where v.storage_path = p_name
       and (v.user_id = auth.uid()
            or app_is_admin(v.board_id)
            or (v.is_public and app_is_member(v.board_id))));
$$;

create or replace function app_can_upload_video_object(p_name text)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from route_videos v
     where v.storage_path = p_name
       and v.user_id = auth.uid()
       and v.status = 'uploading');
$$;

create or replace function app_can_delete_video_object(p_name text)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from route_videos v
     where v.storage_path = p_name
       and (v.user_id = auth.uid() or app_is_admin(v.board_id)));
$$;

-- ── Storage policies (scoped to this bucket; board-images is untouched) ──────
-- No UPDATE policy: a finished file can't be overwritten, only deleted.
drop policy if exists "route_videos objects: read" on storage.objects;
create policy "route_videos objects: read" on storage.objects for select to authenticated
  using (bucket_id = 'route-videos' and app_can_read_video_object(name));

drop policy if exists "route_videos objects: upload" on storage.objects;
create policy "route_videos objects: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'route-videos' and app_can_upload_video_object(name));

drop policy if exists "route_videos objects: delete" on storage.objects;
create policy "route_videos objects: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'route-videos' and app_can_delete_video_object(name));

-- ── 1. Start an upload: consent + membership + limits are all checked here ───
-- The consent wording must match CONSENT_TEXT in src/utils/routeVideos.js.
create or replace function create_route_video(
  p_route_id text, p_mime_type text, p_size_bytes bigint, p_duration_s numeric, p_consent_text text
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

  insert into route_videos (id, route_id, board_id, user_id, storage_path, consent_text, mime_type, size_bytes, duration_s)
  values (v_id, p_route_id, v_board, auth.uid(), v_board::text || '/' || v_id::text || '.' || v_ext,
          p_consent_text, p_mime_type, p_size_bytes, p_duration_s)
  returning * into v;
  return v;
end;
$$;

-- ── 2. Finish an upload: only the uploader, only once the file really exists ─
-- Safe to call twice, so the app can retry after a network blip.
create or replace function finish_route_video(p_video uuid)
returns route_videos
language plpgsql security definer set search_path = public
as $$
declare
  v      route_videos%rowtype;
  v_size bigint;
begin
  select * into v from route_videos where id = p_video;
  if v.id is null or not coalesce(v.user_id = auth.uid(), false) then
    raise exception 'not_found';
  end if;

  select (o.metadata->>'size')::bigint into v_size
    from storage.objects o
   where o.bucket_id = 'route-videos' and o.name = v.storage_path;
  if not found then raise exception 'file_missing'; end if;

  update route_videos
     set status = 'ready', size_bytes = coalesce(v_size, size_bytes), updated_at = now()
   where id = p_video
  returning * into v;
  return v;
end;
$$;

-- ── 3. Make public / make private: that wall's admins only ───────────────────
create or replace function set_route_video_public(p_video uuid, p_public boolean)
returns route_videos
language plpgsql security definer set search_path = public
as $$
declare
  v route_videos%rowtype;
begin
  select * into v from route_videos where id = p_video;
  if v.id is null then raise exception 'not_found'; end if;
  if not app_is_admin(v.board_id) then raise exception 'not_allowed'; end if;
  if v.status <> 'ready' then raise exception 'not_ready'; end if;

  update route_videos
     set is_public    = coalesce(p_public, false),
         published_at = case when p_public then now() end,
         published_by = case when p_public then auth.uid() end,
         updated_at   = now()
   where id = p_video
  returning * into v;
  return v;
end;
$$;

-- ── 4. Delete a row: uploader or wall admin, and only once the file has gone ─
-- Refusing while the file exists means a failed Storage delete can't leave a
-- file behind with no row pointing at it.
create or replace function delete_route_video_row(p_video uuid)
returns void
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
  if exists (select 1 from storage.objects o
              where o.bucket_id = 'route-videos' and o.name = v.storage_path) then
    raise exception 'file_still_exists';
  end if;
  delete from route_videos where id = p_video;
end;
$$;

-- ── 5. Admin clean-up list: videos whose route has gone, plus dead uploads ───
-- Decided HERE, against the real routes table, never from a client's route list:
-- a phone whose route list failed to load would see every video as orphaned.
-- 24 hours matches how long a resumable upload URL stays valid.
create or replace function list_orphan_route_videos(p_board uuid)
returns setof route_videos
language plpgsql security definer stable set search_path = public
as $$
begin
  if not app_is_admin(p_board) then raise exception 'not_allowed'; end if;
  return query
    select v.* from route_videos v
     where v.board_id = p_board
       and (not exists (select 1 from routes r where r.id = v.route_id)
            or (v.status = 'uploading' and v.created_at < now() - interval '24 hours'));
end;
$$;

-- ── 6. Storage gauge for the Settings dropdown: any wall admin ───────────────
create or replace function route_videos_usage()
returns table (used_bytes bigint, cap_bytes bigint, video_count bigint)
language plpgsql security definer stable set search_path = public
as $$
begin
  if not exists (select 1 from board_members bm
                  where bm.user_id = auth.uid() and bm.role = 'admin') then
    raise exception 'not_allowed';
  end if;
  return query
    select route_videos_bytes_used(), route_videos_cap_bytes(),
           (select count(*) from route_videos v where v.status = 'ready');
end;
$$;

-- ── Grants ───────────────────────────────────────────────────────────────────
revoke all on function route_videos_bytes_used()                                  from public;
revoke all on function app_can_read_video_object(text)                            from public;
revoke all on function app_can_upload_video_object(text)                          from public;
revoke all on function app_can_delete_video_object(text)                          from public;
revoke all on function create_route_video(text, text, bigint, numeric, text)      from public;
revoke all on function finish_route_video(uuid)                                   from public;
revoke all on function set_route_video_public(uuid, boolean)                      from public;
revoke all on function delete_route_video_row(uuid)                               from public;
revoke all on function list_orphan_route_videos(uuid)                             from public;
revoke all on function route_videos_usage()                                       from public;
grant execute on function route_videos_bytes_used()                               to authenticated;
grant execute on function app_can_read_video_object(text)                         to authenticated;
grant execute on function app_can_upload_video_object(text)                       to authenticated;
grant execute on function app_can_delete_video_object(text)                       to authenticated;
grant execute on function create_route_video(text, text, bigint, numeric, text)   to authenticated;
grant execute on function finish_route_video(uuid)                                to authenticated;
grant execute on function set_route_video_public(uuid, boolean)                   to authenticated;
grant execute on function delete_route_video_row(uuid)                            to authenticated;
grant execute on function list_orphan_route_videos(uuid)                          to authenticated;
grant execute on function route_videos_usage()                                    to authenticated;

notify pgrst, 'reload schema';

commit;

-- ============================================================
-- ROLLBACK (commented out). Empty the bucket through the Storage API or the
-- dashboard FIRST, or the files are orphaned. This deletes all video records.
-- ============================================================
-- drop policy if exists "route_videos objects: read" on storage.objects;
-- drop policy if exists "route_videos objects: upload" on storage.objects;
-- drop policy if exists "route_videos objects: delete" on storage.objects;
-- drop function if exists route_videos_usage();
-- drop function if exists list_orphan_route_videos(uuid);
-- drop function if exists delete_route_video_row(uuid);
-- drop function if exists set_route_video_public(uuid, boolean);
-- drop function if exists finish_route_video(uuid);
-- drop function if exists create_route_video(text, text, bigint, numeric, text);
-- drop function if exists app_can_delete_video_object(text);
-- drop function if exists app_can_upload_video_object(text);
-- drop function if exists app_can_read_video_object(text);
-- drop function if exists route_videos_bytes_used();
-- drop function if exists route_videos_cap_bytes();
-- drop table if exists route_videos;
-- delete from storage.buckets where id = 'route-videos';
