import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker from './worker.mjs';
import { staffSql } from './create-staff.mjs';

const sql = new DatabaseSync(':memory:');
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
sql.exec(schema);
sql.exec(schema); // safe to run twice, as the deploy does
const stmt = (q) => { let a = []; return { bind(...v) { a = v; return this; }, async first() { return sql.prepare(q).get(...a) || null; }, async all() { return { results: sql.prepare(q).all(...a) }; }, async run() { const r = sql.prepare(q).run(...a); return { meta: { changes: Number(r.changes) } }; } }; };
const DB = { prepare: stmt, async batch(l) { sql.exec('BEGIN'); try { const o = []; for (const s of l) o.push(await s.run()); sql.exec('COMMIT'); return o; } catch (e) { sql.exec('ROLLBACK'); throw e; } } };
const env = { DB, ADMIN_PASSWORD: 'x', MASTER_USERS: 'Boss' };
const call = async (path, method = 'GET', data, token) => {
  const res = await worker.fetch(new Request('https://api.test' + path, { method, headers: { Origin: 'https://everestpokerroom.com', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }), env);
  return { status: res.status, body: await res.json() };
};
sql.exec(await staffSql(['Boss:boss-pass', 'Maria:maria-pass:staff']));
const boss = (await call('/login', 'POST', { username: 'Boss', password: 'boss-pass' })).body.token;
const maria = (await call('/login', 'POST', { username: 'Maria', password: 'maria-pass' })).body.token;

assert.equal((await call('/cage')).status, 401, 'sign-in required');
let r = await call('/cage', 'GET', null, maria);
assert.equal(r.status, 200); assert.equal(r.body.docs.length, 0); assert.equal(r.body.rev, 0);

// Staff record an entry; update it; cannot delete it or change settings.
r = await call('/cage/doc', 'POST', { coll: 'entries', id: 'e1', op: 'set', data: { type: 'buyin', amount: 5000 } }, maria);
assert.equal(r.status, 200); assert.equal(r.body.version, 1);
r = await call('/cage/doc', 'POST', { coll: 'entries', id: 'e1', op: 'update', data: { voided: true } }, maria);
assert.equal(r.status, 200); assert.equal(r.body.version, 2);
assert.equal((await call('/cage/doc', 'POST', { coll: 'entries', id: 'e1', op: 'delete' }, maria)).status, 403);
assert.equal((await call('/cage/doc', 'POST', { coll: 'config', id: 'settings', op: 'set', data: { a: 1 } }, maria)).status, 403);
assert.equal((await call('/cage/doc', 'POST', { coll: 'nope', id: 'x', op: 'set', data: {} }, maria)).status, 400);
assert.equal((await call('/cage/doc', 'POST', { coll: 'entries', id: 'bad id', op: 'set', data: {} }, maria)).status, 400);
assert.equal((await call('/cage/doc', 'POST', { coll: 'entries', id: 'zz', op: 'update', data: {} }, maria)).status, 404);

// Version check.
assert.equal((await call('/cage/doc', 'POST', { coll: 'entries', id: 'e1', op: 'set', data: { x: 1 }, ifVersion: 1 }, maria)).status, 409);

// Manager changes settings and deletes.
assert.equal((await call('/cage/doc', 'POST', { coll: 'config', id: 'settings', op: 'set', data: { openDate: '2026-11-13' } }, boss)).status, 200);
r = await call('/cage', 'GET', null, boss);
assert.equal(r.body.docs.length, 2);
const e1 = r.body.docs.find((d) => d.id === 'e1');
assert.deepEqual(e1.data, { type: 'buyin', amount: 5000, voided: true });
const rev = r.body.rev;
assert.equal((await call('/cage/doc', 'POST', { coll: 'entries', id: 'e1', op: 'delete' }, boss)).status, 200);
r = await call('/cage?since=' + rev, 'GET', null, boss);
assert.equal(r.body.docs.length, 1); assert.equal(r.body.docs[0].deleted, true);

// Photos are kept apart and fetched one at a time.
assert.equal((await call('/cage/doc', 'POST', { coll: 'photos', id: 'c1', op: 'set', data: { data: 'data:image/jpeg;base64,AAAA' } }, maria)).status, 200);
r = await call('/cage?since=0', 'GET', null, maria);
assert.ok(!r.body.docs.some((d) => d.coll === 'photos'));
r = await call('/cage/photo/c1', 'GET', null, maria);
assert.equal(r.body.data, 'data:image/jpeg;base64,AAAA');

// Audit log records settings and deletes.
const log = sql.prepare("SELECT action FROM audit_log WHERE action LIKE 'cage.%'").all().map((x) => x.action);
assert.ok(log.includes('cage.settings') && log.includes('cage.delete'));
console.log('cage tests passed');
