import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker from './worker.mjs';
import { staffSql } from './create-staff.mjs';

const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const stmt = (q) => { let a = []; return { bind(...v) { if (v.length > 100) throw new Error('D1 allows at most 100 bound parameters per query (got ' + v.length + ')'); a = v; return this; }, async first() { return sql.prepare(q).get(...a) || null; }, async all() { return { results: sql.prepare(q).all(...a) }; }, async run() { const r = sql.prepare(q).run(...a); return { meta: { changes: Number(r.changes) } }; } }; };
const DB = { prepare: stmt, async batch(l) { sql.exec('BEGIN'); try { const o = []; for (const s of l) o.push(await s.run()); sql.exec('COMMIT'); return o; } catch (e) { sql.exec('ROLLBACK'); throw e; } } };
const env = { DB, ADMIN_PASSWORD: 'x', MASTER_USERS: 'Boss' };
const call = async (path, method = 'GET', data, token) => {
  const res = await worker.fetch(new Request('https://api.test' + path, { method, headers: { Origin: 'https://everestpokerroom.com', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }), env);
  return { status: res.status, body: await res.json() };
};
// Manila wall clock → ms
sql.exec(await staffSql(['Boss:boss-pass', 'Sam:sam-pass:senior', 'Dan:dan-pass:dealer']));
const boss = (await call('/login', 'POST', { username: 'Boss', password: 'boss-pass' })).body.token;
const sam = await call('/login', 'POST', { username: 'Sam', password: 'sam-pass' }), dan = await call('/login', 'POST', { username: 'Dan', password: 'dan-pass' });
assert.equal(sam.body.role, 'senior'); assert.equal(dan.body.role, 'dealer');
const S = sam.body.token, D = dan.body.token;
await call('/members', 'POST', { nickname: 'Wei', member_no: '000001' }, boss);
// Senior Dealer: reads everything, changes nothing outside insurance.
for (const p of ['/members', '/operation', '/report', '/ppm', '/insurance', '/cage', '/state']) assert.equal((await call(p, 'GET', null, S)).status, 200, 'senior reads ' + p);
assert.equal((await call('/me', 'GET', null, S)).body.role, 'senior');
assert.equal((await call('/members', 'POST', { nickname: 'X', member_no: '000002' }, S)).status, 403, 'senior cannot add members');
assert.equal((await call('/ppm', 'PUT', { version: 0, tables: [] }, S)).status, 403, 'senior cannot change PPM');
assert.equal((await call('/cage/doc', 'POST', { coll: 'entries', id: 'e1', op: 'set', data: {} }, S)).status, 403, 'senior cannot change the cage');
assert.equal((await call('/state', 'PUT', { version: 0, state: {} }, S)).status, 403, 'senior cannot change the waiting list');
assert.equal((await call('/audit', 'GET', null, S)).status, 403, 'History Log stays master only');
assert.equal((await call('/staff', 'GET', null, S)).status, 403, 'staff accounts stay master only');
// Dealer: insurance only.
assert.equal((await call('/insurance', 'GET', null, D)).status, 200);
assert.equal((await call('/insurance/config', 'GET', null, D)).status, 200);
for (const p of ['/members', '/operation', '/report', '/ppm', '/cage']) assert.equal((await call(p, 'GET', null, D)).status, 403, 'dealer cannot open ' + p);
// Both can sell and settle a ticket, neither can void it.
for (const tok of [S, D]) {
  const r = await call('/insurance', 'POST', { table: 'T2', blinds: '50 / 100', players: 2, outs: 9, pot_amount: 30000, amount: 1000, street: 'flop', pot: 'Main', hand_id: 'h' + tok.slice(0, 6) }, tok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call(`/insurance/${r.body.ticket.id}/settle`, 'POST', { hit: false, card: '2c' }, tok)).status, 200);
  assert.equal((await call(`/insurance/${r.body.ticket.id}/void`, 'POST', { reason: 'x' }, tok)).status, 403, 'no void');
}
// The master can give these roles.
assert.equal((await call('/staff', 'POST', { username: 'Neo', password: 'neo-pass', role: 'dealer' }, boss)).status, 200);
assert.equal((await call('/staff/Neo', 'PUT', { role: 'senior' }, boss)).status, 200);
console.log('PASS roles: Senior Dealer reads everything and sells insurance; Dealer only uses insurance; neither voids or changes data');
{ // "Approved by" list: active Managers and the master.
  const a = (await call('/staff/approvers', 'GET', null, S)).body.approvers;
  assert.ok(a.includes('Boss') && !a.includes('Sam') && !a.includes('Dan'), JSON.stringify(a));
  console.log('PASS approvers list');
}
