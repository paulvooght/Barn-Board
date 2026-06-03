-- ============================================================
-- dump_schema.sql — live-schema introspection
--
-- Paste this whole file into the Supabase SQL editor (Dashboard →
-- SQL Editor) and run it. Share the output to verify / reconcile the
-- reconstructed parts of supabase/migrations/000_core_tables.sql
-- (RLS policies, exact column defaults, foreign keys, indexes) — the
-- things the PostgREST OpenAPI schema can't expose.
--
-- Read-only. Safe to run any time.
-- ============================================================

-- 1) Columns: type, nullability, exact default
select table_name, ordinal_position, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
order by table_name, ordinal_position;

-- 2) Primary keys & unique constraints
select tc.table_name, tc.constraint_type, kcu.column_name
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name
 and tc.table_schema   = kcu.table_schema
where tc.table_schema = 'public'
  and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE')
order by tc.table_name, tc.constraint_type, kcu.column_name;

-- 3) Foreign keys
select tc.table_name, kcu.column_name,
       ccu.table_name  as references_table,
       ccu.column_name as references_column,
       rc.delete_rule
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name
join information_schema.constraint_column_usage ccu
  on tc.constraint_name = ccu.constraint_name
join information_schema.referential_constraints rc
  on tc.constraint_name = rc.constraint_name
where tc.table_schema = 'public'
  and tc.constraint_type = 'FOREIGN KEY'
order by tc.table_name, kcu.column_name;

-- 4) Indexes
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
order by tablename, indexname;

-- 5) RLS policies (the important one to reconcile)
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- 6) Which tables have RLS enabled
select relname as table_name, relrowsecurity as rls_enabled
from pg_class
where relnamespace = 'public'::regnamespace
  and relkind = 'r'
order by relname;
