import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker from './worker.mjs';
import { staffSql } from './create-staff.mjs';

const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const stmt = (q) => { let a = []; return { bind(...v) { a = v; return this; }, async first() { return sql.prepare(q).get(...a) || null; }, async all() { return { results: sql.prepare(q).all(...a) }; }, async run() { const r = sql.prepare(q).run(...a); return { meta: { changes: Number(r.changes) } }; } }; };
const DB = { prepare: stmt, async batch(l) { sql.exec('BEGIN'); try { const o = []; for (const s of l) o.push(await s.run()); sql.exec('COMMIT'); return o; } catch (e) { sql.exec('ROLLBACK'); throw e; } } };
const env = { DB, ADMIN_PASSWORD: 'x', MASTER_USERS: 'Boss' };
const call = async (path, method = 'GET', data, token) => {
  const res = await worker.fetch(new Request('https://api.test' + path, { method, headers: { Origin: 'https://everestpokerroom.com', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }), env);
  return { status: res.status, body: await res.json() };
};
sql.exec(await staffSql(['Boss:boss-pass', 'Mary:mary-pass:staff']));
const mary = (await call('/login', 'POST', { username: 'Mary', password: 'mary-pass' })).body.token;
const mk = async (nick) => (await call('/members', 'POST', { nickname: nick, nationality: 'Philippines', confirm_duplicate: true }, mary)).body.member_no;
const A = await mk('Rolan'), B = await mk('Erwin'), C = await mk('Cho');

// PPM: T1 running, Rolan already seated at seat 7 (typed by nickname, as staff do today).
const seat = (id, extra = {}) => ({ id, memberId: '', status: 'idle', activeSeconds: 0, restSeconds: 0, lastActiveStart: null, lastRestStart: null, buyInAmount: 0, transferNote: null, sessionStart: null, selectedForBatch: false, ...extra });
const t0 = Date.now() - 3600e3;
const tables = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, name: ['T1', 'T2', 'T3', 'T5'][i], gameType: 'NLH', blinds: '50 / 100', openedAt: null, closedAt: null, elapsedSeconds: 0, lastStartTime: null, isRunning: i === 0,
  seats: Array.from({ length: 9 }, (_, j) => j === 6 && i === 0 ? seat(7, { memberId: 'Rolan', status: 'seated', lastActiveStart: t0, sessionStart: '2026-11-21 20:00:00', buyInAmount: 10000 }) : seat(j + 1)), sessions: [] }));
assert.equal((await call('/ppm', 'PUT', { version: 0, tables }, mary)).status, 200);

assert.equal((await call('/ppm/waiting')).status, 401, 'sign-in required');
// Add-on: the seated player's buy-in goes up.
let r = await call('/ppm/cage-event', 'POST', { key: 'e1', kind: 'buyin', member_no: A, amount: 5000 }, mary);
assert.equal(r.status, 200); assert.equal(r.body.result.action, 'addon');
let ppm = (await call('/ppm', 'GET', null, mary)).body;
assert.equal(ppm.tables[0].seats[6].buyInAmount, 15000); assert.equal(ppm.version, 2);
// Same event again (retry): not applied twice.
r = await call('/ppm/cage-event', 'POST', { key: 'e1', kind: 'buyin', member_no: A, amount: 5000 }, mary);
assert.equal(r.body.repeated, true);
assert.equal((await call('/ppm', 'GET', null, mary)).body.tables[0].seats[6].buyInAmount, 15000);
// Cash Out Request (clock stopped), then an add-on: the request is cancelled and the clock runs again.
{ const cur = (await call('/ppm', 'GET', null, mary)).body; const st = cur.tables[0].seats[6];
  Object.assign(st, { status: 'rest', lastActiveStart: null, lastRestStart: Date.now() - 60000, activeSeconds: 3600, cashoutAsked: { at: Date.now(), by: 'Phoebe' } });
  assert.equal((await call('/ppm', 'PUT', { version: cur.version, tables: cur.tables }, mary)).status, 200);
  r = await call('/ppm/cage-event', 'POST', { key: 'e1b', kind: 'buyin', member_no: A, amount: 1000 }, mary); assert.equal(r.body.result.action, 'addon');
  const s2 = (await call('/ppm', 'GET', null, mary)).body.tables[0].seats[6];
  assert.equal(s2.status, 'seated'); assert.equal(s2.cashoutAsked, null); assert.ok(s2.lastActiveStart); assert.ok(s2.restSeconds >= 59); assert.equal(s2.buyInAmount, 16000); }
// New player: waiting for a seat; a second buy-in before seating adds up.
r = await call('/ppm/cage-event', 'POST', { key: 'e2', kind: 'buyin', member_no: B, amount: 5000 }, mary);
assert.equal(r.body.result.action, 'waiting');
await call('/ppm/cage-event', 'POST', { key: 'e3', kind: 'buyin', member_no: B, amount: 2000 }, mary);
let w = (await call('/ppm/waiting', 'GET', null, mary)).body.waiting;
assert.equal(w.length, 1); assert.equal(w[0].amount, 7000); assert.equal(w[0].member_no, B);
// Seat: taken seat / closed table refused, free seat works.
assert.equal((await call('/ppm/seat', 'POST', { id: w[0].id, table_id: 1, seat_id: 7 }, mary)).status, 409, 'seat taken');
assert.equal((await call('/ppm/seat', 'POST', { id: w[0].id, table_id: 2, seat_id: 1 }, mary)).status, 409, 'table not running');
r = await call('/ppm/seat', 'POST', { id: w[0].id, table_id: 1, seat_id: 4 }, mary);
assert.equal(r.status, 200); const s4 = r.body.tables[0].seats[3];
assert.equal(s4.status, 'seated'); assert.equal(s4.memberId, B); assert.equal(s4.buyInAmount, 7000); assert.ok(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s4.sessionStart));
assert.equal((await call('/ppm/waiting', 'GET', null, mary)).body.waiting.length, 0, 'off the list once seated');
assert.equal((await call('/ppm/seat', 'POST', { id: w[0].id, table_id: 1, seat_id: 5 }, mary)).status, 409, 'cannot seat twice');
// Cash-out at the cage: the seat is left, the session is written with the cash-out, the member gets the play time.
r = await call('/ppm/cage-event', 'POST', { key: 'e4', kind: 'cashout', member_no: A, amount: 22000 }, mary);
assert.equal(r.body.result.action, 'left'); assert.equal(r.body.result.seat, 7);
ppm = (await call('/ppm', 'GET', null, mary)).body;
assert.equal(ppm.tables[0].seats[6].status, 'idle');
const sess = ppm.tables[0].sessions.find((x) => x.memberId === 'Rolan');
assert.equal(sess.cashOutAmount, 22000); assert.equal(sess.buyInAmount, 16000); assert.ok(sess.activeSeconds >= 3590);
const ps = sql.prepare("SELECT ps.buy_in, sr.cash_out, m.member_no FROM play_sessions ps JOIN members m ON m.id=ps.member_id LEFT JOIN session_results sr ON sr.session_id=ps.id").all();
assert.equal(ps.length, 1); assert.equal(ps[0].member_no, A); assert.equal(ps[0].cash_out, 22000); assert.equal(ps[0].buy_in, 16000);
const pub = (await call('/state')).body.state; assert.equal(pub.occupied[0][6], 0); assert.equal(pub.occupied[0][3], 1);
// Bought in, never seated, cashed out: off the waiting list.
await call('/ppm/cage-event', 'POST', { key: 'e5', kind: 'buyin', member_no: C, amount: 3000 }, mary);
r = await call('/ppm/cage-event', 'POST', { key: 'e6', kind: 'cashout', member_no: C, amount: 3000 }, mary);
assert.equal(r.body.result.action, 'not_seated'); assert.equal((await call('/ppm/waiting', 'GET', null, mary)).body.waiting.length, 0);
// Remove from the waiting list by hand.
await call('/ppm/cage-event', 'POST', { key: 'e7', kind: 'buyin', member_no: C, amount: 1000 }, mary);
w = (await call('/ppm/waiting', 'GET', null, mary)).body.waiting;
assert.equal((await call(`/ppm/waiting/${w[0].id}/remove`, 'POST', { reason: 'left' }, mary)).status, 200);
assert.equal((await call('/ppm/waiting', 'GET', null, mary)).body.waiting.length, 0);
// A name with no member number: PPM untouched.
assert.equal((await call('/ppm/cage-event', 'POST', { key: 'e8', kind: 'buyin', member_no: 'Walk-in', amount: 1000 }, mary)).body.result.action, 'no_member');
assert.equal((await call('/ppm/cage-event', 'POST', { key: 'e9', kind: 'nope', member_no: A, amount: 1 }, mary)).status, 400);
// PPM's own saves keep working after server changes (version moved on).
ppm = (await call('/ppm', 'GET', null, mary)).body;
assert.equal((await call('/ppm', 'PUT', { version: ppm.version, tables: ppm.tables }, mary)).status, 200);
console.log('PASS ppm link: add-on, waiting list, seat, cash-out leaves the seat with session + member play time, retries ignored, public room updated');
