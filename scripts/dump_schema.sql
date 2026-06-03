-- ============================================================
-- dump_schema.sql — live-schema introspection (single-result)
--
-- Paste into the Supabase SQL editor (Dashboard → SQL Editor → New query),
-- click Run, then copy the one JSON cell it returns and share it. Used to
-- verify / reconcile the reconstructed parts of
-- supabase/migrations/000_core_tables.sql (RLS policies, exact defaults,
-- foreign keys, indexes) — the things PostgREST OpenAPI can't expose.
--
-- Read-only. Safe to run any time. Returns ONE row / ONE column (schema_dump).
-- ============================================================

select jsonb_pretty(jsonb_build_object(
  'columns', (
    select jsonb_agg(jsonb_build_object(
      'table', table_name, 'column', column_name, 'type', data_type,
      'nullable', is_nullable, 'default', column_default
    ) order by table_name, ordinal_position)
    from information_schema.columns
    where table_schema = 'public'
  ),
  'keys', (
    select jsonb_agg(jsonb_build_object(
      'table', tc.table_name, 'type', tc.constraint_type, 'column', kcu.column_name
    ))
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
     and tc.table_schema   = kcu.table_schema
    where tc.table_schema = 'public'
      and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE')
  ),
  'foreign_keys', (
    select jsonb_agg(jsonb_build_object(
      'table', tc.table_name, 'column', kcu.column_name,
      'references', ccu.table_name || '.' || ccu.column_name
    ))
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
    join information_schema.constraint_column_usage ccu
      on tc.constraint_name = ccu.constraint_name
    where tc.table_schema = 'public'
      and tc.constraint_type = 'FOREIGN KEY'
  ),
  'indexes', (
    select jsonb_agg(jsonb_build_object(
      'table', tablename, 'name', indexname, 'def', indexdef
    ))
    from pg_indexes where schemaname = 'public'
  ),
  'policies', (
    select jsonb_agg(jsonb_build_object(
      'table', tablename, 'name', policyname, 'command', cmd,
      'roles', roles, 'using', qual, 'with_check', with_check
    ))
    from pg_policies where schemaname = 'public'
  ),
  'rls_enabled', (
    select jsonb_agg(jsonb_build_object(
      'table', relname, 'enabled', relrowsecurity
    ))
    from pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r'
  )
)) as schema_dump;
