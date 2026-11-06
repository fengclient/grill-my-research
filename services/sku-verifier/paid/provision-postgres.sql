-- Run after 001-paid-orders.sql in the same admin transaction, with sku_paid,pg_catalog search_path.
DO $$
BEGIN
  IF to_regclass('sku_paid.paid_orders') IS NULL
    OR to_regprocedure('sku_paid.enforce_paid_order_immutability()') IS NULL THEN
    RAISE EXCEPTION 'Create the private sku_paid schema and apply the existing migration first';
  END IF;
  IF EXISTS (SELECT FROM pg_policy WHERE polrelid = 'sku_paid.paid_orders'::regclass
      AND polname NOT IN ('sku_paid_runtime_select','sku_paid_runtime_insert','sku_paid_runtime_update')) THEN
    RAISE EXCEPTION 'Unexpected policies exist on the private paid order table';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sku_paid_runtime') THEN
    CREATE ROLE sku_paid_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'sku_paid_runtime'
      AND (rolsuper OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT FROM pg_auth_members WHERE member = 'sku_paid_runtime'::regrole
      OR (roleid = 'sku_paid_runtime'::regrole AND member <> current_user::regrole))
    OR EXISTS (SELECT FROM pg_namespace WHERE nspname = 'sku_paid' AND nspowner = 'sku_paid_runtime'::regrole)
    OR EXISTS (SELECT FROM pg_class WHERE oid = 'sku_paid.paid_orders'::regclass AND relowner = 'sku_paid_runtime'::regrole)
    OR EXISTS (SELECT FROM pg_proc WHERE oid = 'sku_paid.enforce_paid_order_immutability()'::regprocedure AND proowner = 'sku_paid_runtime'::regrole) THEN
    RAISE EXCEPTION 'sku_paid_runtime must be an unprivileged non-owner role without memberships';
  END IF;
END;
$$;

ALTER FUNCTION sku_paid.enforce_paid_order_immutability() SET search_path = pg_catalog;
ALTER ROLE sku_paid_runtime SET search_path = sku_paid,pg_catalog;
REVOKE ALL ON SCHEMA sku_paid FROM PUBLIC,sku_paid_runtime;
REVOKE ALL ON TABLE sku_paid.paid_orders FROM PUBLIC,sku_paid_runtime;
REVOKE ALL ON FUNCTION sku_paid.enforce_paid_order_immutability() FROM PUBLIC,sku_paid_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA sku_paid REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA sku_paid REVOKE ALL ON FUNCTIONS FROM PUBLIC;

DO $$
DECLARE principal text;
BEGIN
  FOREACH principal IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = principal) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA sku_paid FROM %I', principal);
      EXECUTE format('REVOKE ALL ON TABLE sku_paid.paid_orders FROM %I', principal);
      EXECUTE format('REVOKE ALL ON FUNCTION sku_paid.enforce_paid_order_immutability() FROM %I', principal);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA sku_paid REVOKE ALL ON TABLES FROM %I', principal);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA sku_paid REVOKE ALL ON FUNCTIONS FROM %I', principal);
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE sku_paid.paid_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sku_paid.paid_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sku_paid_runtime_select ON sku_paid.paid_orders;
DROP POLICY IF EXISTS sku_paid_runtime_insert ON sku_paid.paid_orders;
DROP POLICY IF EXISTS sku_paid_runtime_update ON sku_paid.paid_orders;
CREATE POLICY sku_paid_runtime_select ON sku_paid.paid_orders FOR SELECT TO sku_paid_runtime USING (true);
CREATE POLICY sku_paid_runtime_insert ON sku_paid.paid_orders FOR INSERT TO sku_paid_runtime WITH CHECK (true);
CREATE POLICY sku_paid_runtime_update ON sku_paid.paid_orders FOR UPDATE TO sku_paid_runtime USING (true) WITH CHECK (true);
GRANT USAGE ON SCHEMA sku_paid TO sku_paid_runtime;
GRANT SELECT,INSERT,UPDATE ON TABLE sku_paid.paid_orders TO sku_paid_runtime;
GRANT EXECUTE ON FUNCTION sku_paid.enforce_paid_order_immutability() TO sku_paid_runtime;
