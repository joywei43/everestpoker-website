import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker from './worker.mjs';
import { staffSql } from './create-staff.mjs';

const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const stmt = (q) => { let args = []; return {
  bind(...v) { if (v.length > 100) throw new Error('D1 allows at most 100 bound parameters per query (got ' + v.length + ')'); args = v; return this; },
  async first() { return sql.prepare(q).get(...args) || null; },
  async all() { return { results: sql.prepare(q).all(...args) }; },
  async run() { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; }
}; };
const DB = { prepare: stmt, async batch(list) { sql.exec('BEGIN'); try { const out = []; for (const s of list) out.push(await s.run()); sql.exec('COMMIT'); return out; } catch (e) { sql.exec('ROLLBACK'); throw e; } } };
const env = { DB, ADMIN_PASSWORD: 'test', MASTER_USERS: 'Boss' };
let ip = '1.1.1.1';
const call = async (path, method = 'GET', data, token) => {
  const res = await worker.fetch(new Request('https://api.test' + path, { method, headers: { Origin: 'https://everestpokerroom.com', 'CF-Connecting-IP': ip, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }), env);
  return { status: res.status, body: await res.json() };
};

sql.exec(await staffSql(['Boss:boss-pass', 'Maria:maria-pass:staff']));
const boss = (await call('/login', 'POST', { username: 'boss', password: 'boss-pass' })).body.token;
const maria = (await call('/login', 'POST', { username: 'maria', password: 'maria-pass' })).body.token;
await call('/members', 'POST', { surname: 'Chen', family_name: 'Wei-Lun', nickname: 'Wei', birthday: '1990-05-05', group_id: 'hee' }, boss);
await call('/members', 'POST', { surname: 'Park', family_name: 'Ji-ho', nickname: 'Jiho', birthday: '1988-01-02', group_id: 'dee' }, boss);
await call('/members', 'POST', { nickname: 'NoBirthday' }, boss);

// Open two tables in PPM with a private seat name and a past session.
const seats = (n, t) => Array.from({ length: 9 }, (_, j) => ({ id: j + 1, status: j < n ? 'seated' : 'idle', memberId: j < n ? 'SECRET-' + t + '-' + j : '' }));
const tables = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, name: ['T1', 'T2', 'T3', 'T5'][i], isRunning: i < 2, blinds: i === 0 ? '25 / 50' : '50 / 100', gameType: 'NLH', seats: i < 2 ? seats(i === 0 ? 8 : 9, i) : seats(0, i), sessions: [] }));
tables[0].sessions = [{ seatId: 1, memberId: 'EV-000001', startTime: '2026-10-25 21:00:00', endTime: '2026-10-26 03:30:00', activeSeconds: 21900, restSeconds: 1500, buyInAmount: 25000, transferNote: null }];
assert.equal((await call('/ppm', 'PUT', { version: 0, tables }, boss)).status, 200);

// Public room view: open tables only, no player names.
let room = (await call('/member/room')).body;
assert.equal(room.tables.length, 2); assert.equal(room.tables[0].taken, 8); assert.equal(room.tables[1].taken, 9);
assert.ok(!JSON.stringify(room).includes('SECRET'));

// Sign in with member number + birthday.
assert.equal((await call('/member/me')).status, 401);
assert.equal((await call('/member/login', 'POST', { member_no: 'EV-000001', birthday: '1990-05-06' })).status, 401);
assert.equal((await call('/member/login', 'POST', { member_no: 'EV-000003', birthday: '' })).status, 401, 'no birthday on file');
const wei = (await call('/member/login', 'POST', { member_no: 'ev-000001', birthday: '1990-05-05' })).body.token;
assert.match(wei, /^[a-f0-9]{64}$/);
assert.equal((await call('/members', 'GET', null, wei)).status, 401, 'member token is not a staff token');
let me = (await call('/member/me', 'GET', null, wei)).body;
assert.equal(me.member.nickname, 'Wei'); assert.equal(me.stats.all.secs, 21900); assert.equal(me.sessions[0].blinds, '25 / 50');
const meText = JSON.stringify(me);
for (const hidden of ['buy_in', '25000', 'group', 'hee', 'reward', 'staff_notes', 'passport']) assert.ok(!meText.includes(hidden), 'member must not see ' + hidden);

// Waitlist: join, see place, no double entries, staff screen keeps it.
assert.equal((await call('/member/waitlist', 'POST', { game: '99 / 99 NLH' }, wei)).status, 400);
let w = await call('/member/waitlist', 'POST', { game: '50 / 100 NLH' }, wei);
assert.equal(w.status, 200); assert.equal(w.body.waitlist[0].position, 1);
assert.equal((await call('/member/waitlist', 'POST', { game: '25 / 50 NLH' }, wei)).status, 409);
const jiho = (await call('/member/login', 'POST', { member_no: 'EV-000002', birthday: '1988-01-02' })).body.token;
w = await call('/member/waitlist', 'POST', { game: '50 / 100 NLH' }, jiho);
assert.equal(w.body.waitlist[0].position, 2);
let st = (await call('/state')).body;
assert.deepEqual(st.state.queue.map((p) => p.name), ['Wei', 'Jiho']);
assert.equal((await call('/state', 'PUT', { version: st.version, state: st.state }, maria)).status, 200, 'staff waiting list still saves');
assert.equal((await call('/member/room')).body.waiting['50 / 100 NLH'], 2);
assert.equal((await call('/member/waitlist/leave', 'POST', {}, wei)).body.waitlist.length, 0);
me = (await call('/member/me', 'GET', null, jiho)).body;
assert.equal(me.waitlist[0].position, 1, 'moves up when someone leaves');

// A suspended member is signed out.
await call('/members/EV-000002', 'PUT', { status: 'suspended' }, boss);
assert.equal((await call('/member/me', 'GET', null, jiho)).status, 401);
assert.equal((await call('/member/login', 'POST', { member_no: 'EV-000002', birthday: '1988-01-02' })).status, 403);

// Promotions: managers edit, members see active ones in date range.
assert.equal((await call('/promotions', 'POST', { title: 'Daily Raffle' }, maria)).status, 403);
assert.equal((await call('/promotions', 'POST', { title: 'Daily Raffle', body: 'Draw every night at 22:00' }, boss)).status, 200);
assert.equal((await call('/promotions', 'POST', { title: 'Next year', starts: '2099-01-01' }, boss)).status, 200);
assert.equal((await call('/promotions', 'POST', { title: 'Old', ends: '2000-01-01' }, boss)).status, 200);
const list = (await call('/promotions', 'GET', null, maria)).body.promotions;
assert.equal(list.length, 3);
await call('/promotions/' + list.find((p) => p.title === 'Daily Raffle').id, 'PUT', { title: 'Daily Raffle', body: 'Every night 22:00', sort: 1 }, boss);
room = (await call('/member/room')).body;
assert.deepEqual(room.promotions.map((p) => p.title), ['Daily Raffle']); assert.equal(room.promotions[0].body, 'Every night 22:00');

// Logout and brute-force limit.
assert.equal((await call('/member/logout', 'POST', {}, wei)).status, 200);
assert.equal((await call('/member/me', 'GET', null, wei)).status, 401);
ip = '5.5.5.5';
for (let i = 0; i < 15; i++) assert.equal((await call('/member/login', 'POST', { member_no: 'EV-000001', birthday: '1990-05-05' })).status, 200, 'shared venue Wi-Fi: successful logins never lock out');
ip = '9.9.9.9';
let last;
for (let i = 0; i < 11; i++) last = await call('/member/login', 'POST', { member_no: 'EV-000001', birthday: '2000-01-0' + (i % 9) });
assert.equal(last.status, 429);

console.log('PASS member app: public room without names, number+birthday login, own data only, waitlist join/leave/order, staff list intact, suspended blocked, promotions by managers and dates, logout, login limit');
