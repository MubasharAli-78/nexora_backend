-- ============================================================================
-- Nexora — RLS, functions, triggers, stored procedures
-- Run AFTER tables exist (prisma db push / prisma migrate deploy):
--   pnpm prisma db execute --file prisma/sql/setup.sql --schema prisma/schema/schema.prisma
-- Idempotent: safe to re-run.
-- ============================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ----------------------------------------------------------------------------
-- Request-context helper functions (set per-transaction by the backend via
-- set_config('app.current_*', ..., true) inside withTenantContext()).
-- ----------------------------------------------------------------------------
create or replace function app.current_tenant_id()
returns uuid language sql stable as $$
  select nullif(current_setting('app.current_tenant_id', true), '')::uuid;
$$;

create or replace function app.current_user_id()
returns uuid language sql stable as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid;
$$;

create or replace function app.current_membership_id()
returns uuid language sql stable as $$
  select nullif(current_setting('app.current_membership_id', true), '')::uuid;
$$;

create or replace function app.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function app.increment_tenant_rbac_version(p_tenant_id uuid)
returns void language plpgsql security definer as $$
begin
  update app.tenants
     set rbac_version = rbac_version + 1, updated_at = now()
   where id = p_tenant_id;
end;
$$;

-- Atomic permission toggle for a role. Bumps tenant rbac_version and the
-- membership_permission_version of every member holding the role, then audits.
create or replace function app.set_role_permissions(
  p_tenant_id      uuid,
  p_role_id        uuid,
  p_permission_ids uuid[],
  p_actor_user_id  uuid
) returns void language plpgsql security definer as $$
begin
  delete from app.role_permissions
   where tenant_id = p_tenant_id and role_id = p_role_id;

  if array_length(p_permission_ids, 1) is not null then
    insert into app.role_permissions (id, tenant_id, role_id, permission_id, created_at)
    select gen_random_uuid(), p_tenant_id, p_role_id, unnest(p_permission_ids), now();
  end if;

  update app.tenants
     set rbac_version = rbac_version + 1, updated_at = now()
   where id = p_tenant_id;

  update app.tenant_memberships tm
     set membership_permission_version = membership_permission_version + 1,
         updated_at = now()
   where tm.tenant_id = p_tenant_id
     and exists (
       select 1 from app.role_assignments ra
        where ra.tenant_id = p_tenant_id
          and ra.role_id = p_role_id
          and ra.membership_id = tm.id
     );

  insert into app.audit_logs (id, tenant_id, actor_user_id, action, resource_type, resource_id, after_json, created_at)
  values (gen_random_uuid(), p_tenant_id, p_actor_user_id, 'roles.permissions_updated', 'role', p_role_id,
          jsonb_build_object('permission_ids', p_permission_ids), now());
end;
$$;

-- ----------------------------------------------------------------------------
-- updated_at triggers
-- ----------------------------------------------------------------------------
do $$
declare t text;
declare touch_tables text[] := array[
  'users','user_credentials','user_sessions','tenants','tenant_memberships',
  'roles','stores','tenant_integrations','external_object_mappings',
  'products','product_variants','commerce_customers','orders',
  'inventory_locations','inventory_levels','prediction_insights','campaigns',
  'fraud_rules','fraud_alerts','email_campaigns','email_flows',
  'subscription_contracts','customer_segments'
];
begin
  foreach t in array touch_tables loop
    execute format('drop trigger if exists trg_%1$s_touch on app.%1$s', t);
    execute format(
      'create trigger trg_%1$s_touch before update on app.%1$s
         for each row execute function app.touch_updated_at()', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Row Level Security (safety net). Primary isolation is explicit tenant_id
-- filters in the repositories; RLS is the database-level backstop.
--
-- NOTE: Supabase's pooled `postgres` role bypasses RLS. For the backstop to be
-- active in production, connect the app as a dedicated NON-superuser role
-- (see README "Hardening RLS"). The app stays correct either way because every
-- repository also filters by tenant_id explicitly.
-- ----------------------------------------------------------------------------

-- Standard tenant-owned tables: strict tenant_id match.
do $$
declare t text;
declare strict_tables text[] := array[
  'tenant_domains','tenant_invitations','role_assignments','stores',
  'tenant_integrations','integration_credentials','external_object_mappings',
  'sync_runs','products','product_variants','product_images',
  'commerce_customers','customer_addresses','orders','order_items',
  'inventory_locations','inventory_levels','inventory_movements','files',
  'kpi_snapshots','daily_sales_metrics','daily_product_metrics',
  'daily_customer_metrics','prediction_runs','prediction_series_points',
  'prediction_insights','campaigns','campaign_metrics_daily',
  'fraud_rules','fraud_alerts','risk_events','email_campaigns','email_flows',
  'email_events','report_runs','subscription_contracts','subscription_events',
  'customer_segments','customer_segment_memberships'
];
begin
  foreach t in array strict_tables loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('drop policy if exists %I on app.%I', t || '_tenant_isolation', t);
    execute format(
      'create policy %I on app.%I
         using (tenant_id = app.current_tenant_id())
         with check (tenant_id = app.current_tenant_id())',
      t || '_tenant_isolation', t);
  end loop;
end $$;

-- tenant_memberships: tenant match OR the row belongs to the current user
-- (lets a user read their own memberships across tenants during login).
alter table app.tenant_memberships enable row level security;
alter table app.tenant_memberships force row level security;
drop policy if exists tenant_memberships_isolation on app.tenant_memberships;
create policy tenant_memberships_isolation on app.tenant_memberships
  using (tenant_id = app.current_tenant_id() or user_id = app.current_user_id())
  with check (tenant_id = app.current_tenant_id());

-- permissions / roles / role_permissions: tenant rows OR global (null-tenant)
-- system rows are readable; writes must target the current tenant.
do $$
declare t text;
declare rbac_tables text[] := array['permissions','roles','role_permissions'];
begin
  foreach t in array rbac_tables loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('drop policy if exists %I on app.%I', t || '_read', t);
    execute format(
      'create policy %I on app.%I for select
         using (tenant_id = app.current_tenant_id() or tenant_id is null)',
      t || '_read', t);
    execute format('drop policy if exists %I on app.%I', t || '_write', t);
    execute format(
      'create policy %I on app.%I for all
         using (tenant_id = app.current_tenant_id())
         with check (tenant_id = app.current_tenant_id())',
      t || '_write', t);
  end loop;
end $$;

-- audit_logs / outbox_events / webhook_events: tenant rows OR platform (null) rows.
do $$
declare t text;
declare nullable_tables text[] := array['audit_logs','outbox_events','webhook_events'];
begin
  foreach t in array nullable_tables loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('drop policy if exists %I on app.%I', t || '_isolation', t);
    execute format(
      'create policy %I on app.%I
         using (tenant_id = app.current_tenant_id() or tenant_id is null)
         with check (tenant_id = app.current_tenant_id() or tenant_id is null)',
      t || '_isolation', t);
  end loop;
end $$;
