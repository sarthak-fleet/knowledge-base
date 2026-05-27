-- Grok Issue 1 — no DDL needed. Postgres advisory locks are session-scoped
-- functions (`pg_try_advisory_lock`, `pg_advisory_unlock`) requiring no schema.
-- This file exists as a documentation hook + migration-ordering placeholder
-- so the operator knows the locks are intentional and what slot we reserve.

-- We reserve advisory-lock key 4242 for the "vector collection bootstrap"
-- mutex. Distinct from any other lock the application takes (none today;
-- if more are added, document them here).
SELECT 4242 AS reserved_advisory_lock_key WHERE FALSE;
