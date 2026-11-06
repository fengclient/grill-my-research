import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const databaseUrl = process.env.SKU_TEST_DATABASE_URL;
test('private PostgreSQL provisioning grants only the paid runtime lifecycle permissions', { skip: !databaseUrl && 'Set explicit SKU_TEST_DATABASE_URL to a disposable test database.' }, async () => {
  assert.match(new URL(databaseUrl).pathname, /test/i);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    assert.equal((await client.query("SELECT to_regnamespace('sku_paid') AS schema")).rows[0].schema, null, 'Use a test database without an existing sku_paid schema.');
    await client.query('CREATE SCHEMA sku_paid');
    await client.query('SET LOCAL search_path = sku_paid,pg_catalog');
    await client.query(await readFile(new URL('../migrations/001-paid-orders.sql', import.meta.url), 'utf8'));
    for (const principal of ['anon','authenticated']) {
      if (!(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [principal])).rows.length) await client.query(`CREATE ROLE ${principal} NOLOGIN`);
      await client.query(`GRANT ALL ON SCHEMA sku_paid TO ${principal}`);
      await client.query(`GRANT ALL ON sku_paid.paid_orders TO ${principal}`);
    }
    await client.query('GRANT ALL ON SCHEMA sku_paid TO PUBLIC');
    await client.query('GRANT ALL ON sku_paid.paid_orders TO PUBLIC');
    const provision = await readFile(new URL('../paid/provision-postgres.sql', import.meta.url), 'utf8');
    await client.query(provision);
    await client.query(provision);
    await client.query('SAVEPOINT unexpected_policy');
    await client.query('CREATE POLICY unrelated_anon ON sku_paid.paid_orders FOR SELECT TO anon USING (true)');
    await assert.rejects(client.query(provision), error => error.code === 'P0001' && /Unexpected policies/.test(error.message));
    await client.query('ROLLBACK TO SAVEPOINT unexpected_policy');
    await client.query('RELEASE SAVEPOINT unexpected_policy');
    const role = (await client.query("SELECT rolcanlogin,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig FROM pg_roles WHERE rolname='sku_paid_runtime'")).rows[0];
    for (const flag of ['rolcanlogin','rolsuper','rolinherit','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls']) assert.equal(role[flag], false);
    assert(role.rolconfig.some(value => value.replaceAll(' ', '') === 'search_path=sku_paid,pg_catalog'));
    const triggerFunction = (await client.query("SELECT proconfig FROM pg_proc WHERE oid='sku_paid.enforce_paid_order_immutability()'::regprocedure")).rows[0];
    assert.deepEqual(triggerFunction.proconfig, ['search_path=pg_catalog']);
    const table = (await client.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='sku_paid.paid_orders'::regclass")).rows[0];
    assert.equal(table.relrowsecurity, true); assert.equal(table.relforcerowsecurity, true);
    const policies = (await client.query("SELECT cmd,roles::text[] AS roles FROM pg_policies WHERE schemaname='sku_paid' AND tablename='paid_orders' ORDER BY cmd")).rows;
    assert.deepEqual(policies.map(policy => policy.cmd), ['INSERT','SELECT','UPDATE']);
    assert(policies.every(policy => policy.roles.length === 1 && policy.roles[0] === 'sku_paid_runtime'));

    async function denied(sql) {
      await client.query('SAVEPOINT permission_check');
      await assert.rejects(client.query(sql), error => error.code === '42501');
      await client.query('ROLLBACK TO SAVEPOINT permission_check');
      await client.query('RELEASE SAVEPOINT permission_check');
    }
    await client.query('SET LOCAL ROLE sku_paid_runtime');
    const orderId = 'a'.repeat(32);
    await client.query(`INSERT INTO paid_orders (order_id,capability_hash,target,target_hash,price_fen,service_id,goods_name,pay_before)
      VALUES ($1,'capability','{}','target',99,'service','SKU',now()+interval '30 minutes')`, [orderId]);
    assert.equal((await client.query('SELECT order_id FROM paid_orders')).rows[0].order_id, orderId);
    assert.equal((await client.query("UPDATE paid_orders SET payment_link='amt_test' RETURNING payment_link")).rows[0].payment_link, 'amt_test');
    await client.query("UPDATE paid_orders SET state='running',trade_no='trade',claim_token='claim',execution_started=now(),execution_deadline=now()+interval '10 minutes'");
    await client.query("UPDATE paid_orders SET state='finished',report='{\"status\":\"completed\"}',markdown='report',report_sha256='hash'");
    assert.equal((await client.query('SELECT state FROM paid_orders')).rows[0].state, 'finished');
    await denied('DELETE FROM paid_orders');
    await denied('TRUNCATE paid_orders');
    await denied('CREATE TABLE sku_paid.forbidden (id integer)');
    await denied('ALTER TABLE paid_orders DISABLE ROW LEVEL SECURITY');
    await denied('DROP TABLE paid_orders');
    await client.query('RESET ROLE');
    for (const principal of ['anon','authenticated']) {
      await client.query(`SET LOCAL ROLE ${principal}`);
      await denied('SELECT * FROM sku_paid.paid_orders');
      await denied("INSERT INTO sku_paid.paid_orders (order_id) VALUES ('b')");
      await denied('CREATE TABLE sku_paid.forbidden (id integer)');
      await client.query('RESET ROLE');
    }
  } finally { await client.query('ROLLBACK'); await client.end(); }
});
