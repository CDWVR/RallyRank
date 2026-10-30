-- Auth shim: provides the pieces of Supabase the later migrations rely on, on plain Postgres.
--   * roles anon / authenticated (PostgREST switches into these) and authenticator (PostgREST logs in as it)
--   * auth.users + auth.uid(), so profiles FKs, the on_auth_user_created trigger and every RLS policy work unchanged
--   * auth.refresh_tokens for the web server's session handling
--   * Supabase's default grants on schema public; RLS (enabled on every table) remains the gatekeeper
-- The authenticator password is set by scripts/migrate.mjs from AUTHENTICATOR_PASSWORD, never stored here.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
end
$$;

grant anon, authenticated to authenticator;

create schema if not exists auth;
-- Only the owner (the migration/server role) can see auth.*; PostgREST roles get just auth.uid().
revoke all on schema auth from public;
grant usage on schema auth to anon, authenticated;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  encrypted_password text not null,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists users_email_key on auth.users (lower(email));

create table if not exists auth.refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  -- Every token issued from one login shares a family; reusing a revoked token revokes the whole family.
  family_id uuid not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists refresh_tokens_family_idx on auth.refresh_tokens (family_id);

-- Same contract as Supabase: the user id is the "sub" claim of the JWT PostgREST verified for this request.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid;
$$;

revoke all on function auth.uid() from public;
grant execute on function auth.uid() to anon, authenticated;

-- Supabase's defaults for schema public. Objects created by later migrations inherit these.
grant usage on schema public to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;
grant all on all functions in schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
