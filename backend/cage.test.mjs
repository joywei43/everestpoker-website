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
sql.exec(await staffSql(['Boss:boss-pass', 'Maria:maria-pass:staff', 'Ana:ana-pass:admin']));
const boss = (await call('/login', 'POST', { username: 'Boss', password: 'boss-pass' })).body.token;
const maria = (await call('/login', 'POST', { username: 'Maria', password: 'maria-pass' })).body.token;

assert.equal((await call('/cage')).status, 401, 'sign-in required');
let r = await call('/cage', 'GET', null, maria);
assert.equal(r.status, 200); assert.equal(r.body.docs.length, 0); assert.equal(r.body.rev, 0);

// Staff record an entry and void it: every staff account has full access to the cage.
r = await call('/cage/doc', 'POST', { coll: 'entries', id: 'e1', op: 'set', data: { type: 'buyin', amount: 5000 } }, maria);
assert.equal(r.status, 200); assert.equal(r.body.version, 1);
r = await call('/cage/doc', 'POST', { coll: 'entries', id: 'e1', op: 'update', data: { voided: true } }, maria);
assert.equal(r.status, 200, 'staff can void'); assert.equal(r.body.version, 2);
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
assert.deepEqual(e1.data, { type: 'buyin', amount: 5000, by: 'Maria', voided: true, voidedBy: 'Maria' });
const rev = r.body.rev;
assert.equal((await call('/cage/doc', 'POST', { coll: 'entries', id: 'e1', op: 'delete' }, boss)).status, 200);
r = await call('/cage?since=' + rev, 'GET', null, boss);
assert.equal(r.body.docs.length, 1); assert.equal(r.body.docs[0].deleted, true);
// Staff can also change settings and delete.
assert.equal((await call('/cage/doc', 'POST', { coll: 'manpower', id: 'm1', op: 'set', data: { a: 1 } }, maria)).status, 200, 'staff can change settings');
assert.equal((await call('/cage/doc', 'POST', { coll: 'manpower', id: 'm1', op: 'delete' }, maria)).status, 200, 'staff can delete');

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

// PPM comparison rows are open to staff and carry names and numbers only.
r = await call('/cage/ppm?day=2026-11-14', 'GET', null, maria);
assert.equal(r.status, 200); assert.ok(Array.isArray(r.body.rows));
console.log('cage ppm ok');
await env.DB.prepare("INSERT INTO insurance_tickets(day,created_at,created_by,table_name,blinds,street,pot,players,outs,odds,pot_amount,max_buy,amount,payout,result,detail) VALUES('2026-11-14',1,'x','T1','50 / 100','turn','Main',2,8,3.5,10000,2000,1000,3500,'miss','{}'),('2026-11-14',2,'x','T1','50 / 100','turn','Main',2,8,3.5,10000,2000,500,1750,'hit','{}'),('2026-11-14',3,'x','T2','50 / 100','turn','Main',2,8,3.5,10000,2000,400,1400,'pending','{}'),('2026-11-14',4,'x','T2','50 / 100','turn','Main',2,8,3.5,10000,2000,900,3150,'void','{}')").run();
r = await call('/cage/insurance?from=2026-11-14&to=2026-11-14', 'GET', null, maria);
assert.equal(r.status, 200);
assert.deepEqual([r.body.days['2026-11-14'].net, r.body.days['2026-11-14'].pending, r.body.days['2026-11-14'].tickets, r.body.tickets.length], [-750, 1, 3, 3]);
assert.equal((await call('/cage/insurance?from=x&to=2026-11-14', 'GET', null, maria)).status, 400);
console.log('cage insurance ok');
{ // entries remember who recorded and who voided them
  await call('/cage/doc', 'POST', { coll: 'entries', id: 'byTest1', op: 'set', data: { amount: 1, by: 'Fake' } }, maria);
  await call('/cage/doc', 'POST', { coll: 'entries', id: 'byTest1', op: 'update', data: { voided: true, voidReason: 'x' } }, boss);
  const all = (await call('/cage?since=0', 'GET', null, boss)).body;
  const d = (all.docs || all.changes || []).find((x) => x.id === 'byTest1');
  const data = d.data || d;
  assert.equal(data.by, 'Maria'); assert.equal(data.voidedBy, 'Boss');
  console.log('cage by ok');
{ // correction requests
  const put = (id, data, tok) => call('/cage/doc', 'POST', { coll: 'corrections', id, op: id === 'c1' && !data.status ? 'set' : 'set', data }, tok);
  assert.equal((await put('c1', { status: 'pending', entryId: 'e1', money: true, reason: 'x' }, maria)).status, 200);
  assert.equal((await put('c1', { status: 'approved' }, maria)).status, 403, 'staff cannot approve');
  const ana = (await call('/login', 'POST', { username: 'Ana', password: 'ana-pass' })).body.token;
  assert.equal((await put('c1', { status: 'approved' }, ana)).status, 403, 'manager cannot approve an amount change');
  assert.equal((await put('c1', { status: 'approved', note: 'ok' }, boss)).status, 200);
  assert.equal((await put('c1', { status: 'rejected' }, boss)).status, 409, 'decided once');
  assert.equal((await call('/cage/doc', 'POST', { coll: 'corrections', id: 'c1', op: 'delete' }, boss)).status, 403);
  assert.equal((await put('c2', { status: 'pending', money: false }, maria)).status, 200);
  assert.equal((await put('c2', { status: 'approved' }, ana)).status, 200, 'manager approves a non-amount change');
  console.log('cage corrections ok');
}
}

// ----- Member cards -----
{
  sql.exec(await staffSql(['Phoebe:phoebe-pass:admin']));
  const mk = async (nick) => (await call('/members', 'POST', { nickname: nick, nationality: 'Philippines', confirm_duplicate: true }, maria)).body.member_no;
  const a = await mk('Card Tester A'), b2 = await mk('Card Tester B');
  assert.ok(a && b2, 'members created by staff');
  const ok = { approver_user: 'Phoebe', approver_password: 'phoebe-pass' };
  let c = await call('/cage/card/04A1B2C3', 'GET', null, maria);
  assert.equal(c.status, 200); assert.equal(c.body.unknown, true, 'new card is unknown');
  assert.equal((await call('/cage/card/link', 'POST', { uid: '04A1B2C3', member_no: a }, maria)).status, 403, 'staff need a manager');
  assert.equal((await call('/cage/card/link', 'POST', { uid: '04A1B2C3', member_no: a, approver_user: 'Phoebe', approver_password: 'nope' }, maria)).status, 403, 'wrong password');
  c = await call('/cage/card/link', 'POST', { uid: '04A1B2C3', member_no: a, approver_user: 'Maria', approver_password: 'maria-pass' }, maria);
  assert.equal(c.status, 403, 'a staff account cannot approve'); assert.match(c.body.error, /not a manager/);
  c = await call('/cage/card/link', 'POST', { uid: '04:a1:b2:c3', member_no: a, ...ok }, maria);
  assert.equal(c.status, 200); assert.equal(c.body.member.member_no, a);
  c = await call('/cage/card/04A1B2C3', 'GET', null, maria);
  assert.equal(c.body.member.member_no, a); assert.equal(c.body.member.nationality, 'Philippines'); assert.ok(c.body.card);
  assert.equal(c.body.card.linked_by, 'Maria');
  assert.equal((await call('/cage/card/link', 'POST', { uid: '04A1B2C3', member_no: b2, ...ok }, maria)).status, 409, 'a card belongs to one member');
  c = await call('/cage/card/link', 'POST', { uid: '3912374512', member_no: a }, boss);
  assert.equal(c.status, 200, 'a manager signed in approves by itself'); assert.deepEqual(c.body.replaced, ['04A1B2C3']);
  assert.equal((await call('/cage/card/04A1B2C3', 'GET', null, maria)).body.inactive, true, 'replaced card is off');
  c = await call('/cage/cards?member_no=' + a, 'GET', null, maria);
  assert.equal(c.body.cards.length, 2); assert.equal(c.body.cards.filter((x) => x.active).length, 1);
  assert.equal((await call('/cage/card/link', 'POST', { uid: '04A1B2C3', member_no: b2, ...ok }, maria)).status, 200, 'an old card can be given again');
  assert.equal((await call('/cage/card/04A1B2C3', 'GET', null, maria)).body.member.member_no, b2);
  assert.equal((await call('/cage/card/off', 'POST', { uid: '04A1B2C3', ...ok }, maria)).status, 200);
  assert.equal((await call('/cage/card/04A1B2C3', 'GET', null, maria)).body.inactive, true);
  assert.equal((await call('/cage/card/xx', 'GET', null, maria)).status, 400);
  // Too many wrong passwords for one account → wait.
  for (let i = 0; i < 5; i++) await call('/cage/card/off', 'POST', { uid: '3912374512', approver_user: 'Ana', approver_password: 'bad' }, maria);
  assert.equal((await call('/cage/card/off', 'POST', { uid: '3912374512', approver_user: 'Ana', approver_password: 'ana-pass' }, maria)).status, 429, 'locked after 5 wrong tries');

  // Rewards at the cage: approved by a manager's Admin login, recorded in the cage at once.
  let rw = await call('/rewards/issue', 'POST', { member_no: a, type: 'promo_chip', amount: 2000, detail: 'High hand', pay: 'chips', approver_user: 'Phoebe', approver_password: 'x' }, maria);
  assert.equal(rw.status, 403, 'wrong password');
  rw = await call('/rewards/issue', 'POST', { member_no: a, type: 'promo_chip', amount: 2000, detail: 'High hand', pay: 'chips', ...ok }, maria);
  assert.equal(rw.status, 200); assert.equal(rw.body.approved, true); assert.equal(rw.body.approved_by, 'Phoebe');
  const e = (await call('/cage', 'GET', null, maria)).body.docs.find((d) => d.id === 'rw-' + rw.body.id);
  assert.ok(e && e.data.type === 'comp_chips' && e.data.approver === 'Phoebe', 'reward is in the cage');
  rw = await call('/rewards/issue', 'POST', { member_no: a, type: 'promo_cash', amount: 500, detail: 'Birthday', pay: 'cash' }, maria);
  assert.equal(rw.body.approved, false, 'without a manager it waits for approval');
}
console.log('cage cards ok');
