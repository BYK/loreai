-- 0037_function_search_path.sql
-- Security hardening: pin an empty search_path on the five trigger functions the
-- Supabase security advisor flagged as `function_search_path_mutable`. A mutable
-- search_path lets a caller's session search_path decide which schema an
-- UNqualified object reference resolves to — a classic privilege-escalation /
-- object-shadowing vector. Pinning `search_path = ''` forces every reference to
-- be schema-qualified (or a pg_catalog builtin, which is always implicitly
-- resolvable), removing the ambiguity.
--
-- All five are SECURITY INVOKER trigger functions whose only references are
-- `now()` (pg_catalog builtin — resolves under empty search_path) and, in
-- sync_device_progress_cap, `public.sync_device_progress` (already qualified).
-- So `ALTER FUNCTION ... SET search_path = ''` is behavior-preserving; no body
-- rewrite is needed.
--
-- ALTER (not CREATE OR REPLACE) so the change is minimal and cannot drift from
-- the current bodies. Idempotent: re-setting the same GUC is a no-op.

alter function public.set_profiles_updated_at()      set search_path = '';
alter function public.sync_set_updated_at()           set search_path = '';
alter function public.guard_scope_key_immutable()     set search_path = '';
alter function public.sync_device_progress_touch()    set search_path = '';
alter function public.sync_device_progress_cap()      set search_path = '';
