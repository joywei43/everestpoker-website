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
const at = (s) => Date.parse(s.replace(' ', 'T') + '+08:00');
let clock = at('2026-11-02 11:00:00');
Date.now = () => clock;

sql.exec(await staffSql(['Boss:boss-pass', 'Maria:maria-pass:staff']));
let boss = (await call('/login', 'POST', { username: 'Boss', password: 'boss-pass' })).body.token;
const relogin = async () => { boss = (await call('/login', 'POST', { username: 'Boss', password: 'boss-pass' })).body.token; };
const maria = (await call('/login', 'POST', { username: 'Maria', password: 'maria-pass' })).body.token;
assert.equal((await call('/operation', 'GET', null, maria)).status, 403, 'managers only');
await call('/members', 'POST', { nickname: 'Wei', member_no: '000001' }, boss);
await call('/members', 'POST', { nickname: 'Jiho', member_no: '000002' }, boss);

const idle = () => Array.from({ length: 9 }, (_, j) => ({ id: j + 1, status: 'idle', memberId: '' }));
let version = 0;
const tables = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, name: ['T1', 'T2', 'T3', 'T5'][i], isRunning: false, blinds: '50 / 100', gameType: 'NLH', seats: idle(), sessions: [], elapsedSeconds: 0, lastStartTime: null, openedAt: null }));
const save = async () => { await relogin(); const r = await call('/ppm', 'PUT', { version, tables }, boss); assert.equal(r.status, 200, JSON.stringify(r.body)); version = r.body.version; };

// 11:00: before noon, nothing open → still yesterday's business day.
let op = (await call('/operation', 'GET', null, boss)).body;
assert.equal(op.day, '2026-11-01');

// 13:00 T1 opens, 14:00 T3 opens.
clock = at('2026-11-02 13:00:00'); tables[0].isRunning = true; tables[0].lastStartTime = clock; tables[0].openedAt = '2026-11-02 13:00:00'; await save();
clock = at('2026-11-02 14:00:00'); tables[2].isRunning = true; tables[2].lastStartTime = clock; tables[2].openedAt = '2026-11-02 14:00:00'; await save();
// Finished sessions: Wei 13:10–17:10 buy 20k cash 32k; walk-in "Bob" 14:00–16:00 buy 10k busted; Jiho 15:00–16:00 buy 5k no cash-out.
tables[0].sessions = [
  { seatId: 1, memberId: '000001', startTime: '2026-11-02 13:10:00', endTime: '2026-11-02 17:10:00', activeSeconds: 13000, restSeconds: 1400, buyInAmount: 20000, cashOutAmount: 32000, busted: false },
  { seatId: 2, memberId: 'Bob', startTime: '2026-11-02 14:00:00', endTime: '2026-11-02 16:00:00', activeSeconds: 7200, restSeconds: 0, buyInAmount: 10000, cashOutAmount: 0, busted: true },
  { seatId: 3, memberId: 'Jiho', startTime: '2026-11-02 15:00:00', endTime: '2026-11-02 16:00:00', activeSeconds: 3600, restSeconds: 0, buyInAmount: 5000 }
];
// Wei came back and is seated now with 15k; a new walk-in "Ann" is resting with 8k.
clock = at('2026-11-02 20:00:00');
tables[0].seats[0] = { id: 1, status: 'seated', memberId: '000001', sessionStart: '2026-11-02 18:00:00', activeSeconds: 6000, restSeconds: 0, lastActiveStart: clock, buyInAmount: 15000 };
tables[0].seats[1] = { id: 2, status: 'rest', memberId: 'Ann', sessionStart: '2026-11-02 19:00:00', activeSeconds: 1800, restSeconds: 600, lastActiveStart: null, lastRestStart: clock, buyInAmount: 8000 };
await save();
// 22:00 T3 closes.
clock = at('2026-11-02 22:00:00'); tables[2].isRunning = false; tables[2].lastStartTime = null; tables[2].closedAt = '2026-11-02 22:00:00'; await save();

// 01:00 next calendar day: still business day 2026-11-02.
clock = at('2026-11-03 01:00:00'); await relogin();
op = (await call('/operation', 'GET', null, boss)).body;
assert.equal(op.day, '2026-11-02'); assert.equal(op.is_today, true);
assert.equal(op.start, at('2026-11-02 12:00:00') / 1000, 'opens at noon');
assert.equal(op.open_tables, 1);
const t1 = op.tables.find((t) => t.name === 'T1');
assert.equal(t1.seated, 1); assert.equal(t1.resting, 1); assert.equal(t1.buy_in_on_table, 23000);
assert.deepEqual(t1.players.map((p) => [p.seat, p.ref, p.status, p.buy_in, p.member && p.member.member_no]), [[1, '000001', 'seated', 15000, 'EV-000001'], [2, 'Ann', 'rest', 8000, null]]);
assert.equal(t1.players[0].member.nickname, 'Wei'); assert.ok(t1.players[0].active_seconds >= 6000);
assert.equal(op.operating.since, at('2026-11-02 13:00:00') / 1000);
assert.equal(op.operating.seconds, 12 * 3600, '13:00 → 01:00');
assert.equal(op.operating.table_seconds, 12 * 3600 + 8 * 3600, 'T1 12 h + T3 8 h');
assert.equal(op.visitors.total, 4, 'Wei, Bob, Jiho finished + Ann at the table (Wei counted once)');
assert.equal(op.visitors.at_table_now, 2);
assert.equal(op.money.buy_in_finished, 35000); assert.equal(op.money.buy_in_live, 23000); assert.equal(op.money.buy_in_total, 58000);
assert.equal(op.money.cash_out, 32000); assert.equal(op.money.missing_cash_out, 1); assert.equal(op.money.busted, 1);
assert.equal(op.play.finished_seconds, 23800);
const vl = op.visitor_list;
assert.deepEqual(vl.map((v) => v.member_no || v.ref), ['EV-000001', 'Ann', 'Bob', 'EV-000002'], 'playing now first, then by play time');
assert.equal(vl[0].buy_in, 35000); assert.equal(vl[0].cash_out, 32000); assert.equal(vl[0].win_loss, 12000); assert.ok(vl[0].play_seconds >= 19000); assert.equal(vl[0].playing_now.table, 'T1');
const bob = vl.find((v) => v.ref === 'Bob'); assert.equal(bob.busted, 1); assert.equal(bob.win_loss, -10000);
assert.equal(vl.find((v) => v.member_no === 'EV-000002').missing_cash_out, 1);
assert.equal(vl[0].sessions, 2, 'Wei left and came back: two sessions'); assert.deepEqual(vl[0].segments.map((x) => [x.table, x.seat, !!x.live]), [['T1', 1, false], ['T1', 1, true]]);

// A morning opening moves the next day's start earlier.
clock = at('2026-11-03 10:30:00'); tables[1].isRunning = true; tables[1].lastStartTime = clock; tables[1].openedAt = '2026-11-03 10:30:00'; await save();
op = (await call('/operation', 'GET', null, boss)).body;
assert.equal(op.day, '2026-11-03', 'table opened at 10:30 starts the new business day');
assert.equal(op.start, at('2026-11-03 10:30:00') / 1000);
const prev = (await call('/operation?day=2026-11-02', 'GET', null, boss)).body;
assert.equal(prev.end, at('2026-11-03 10:30:00') / 1000, 'previous day ends when the next one opens');
assert.equal(prev.tables.length, 0, 'no live tables on a past day');
assert.equal(prev.money.buy_in_finished, 35000);
assert.equal(op.history[0].day, '2026-11-02'); assert.equal(op.history[0].buy_in, 35000);


// Operation Report: managers enter revenue and BBJ per day; the rest comes from PPM.
await relogin(); const maria2 = (await call('/login', 'POST', { username: 'Maria', password: 'maria-pass' })).body.token;
assert.equal((await call('/report', 'GET', null, maria2)).status, 403, 'report: managers only');
assert.equal((await call('/report/day/2026-10-31', 'PUT', { bbj_main: '270,000.00', bbj_reserve: '74,000' }, boss)).status, 200);
assert.equal((await call('/report/day/2026-11-02', 'PUT', { tables: { T1: '50,000', T3: 35000 }, bbj_main: '273,962.25', bbj_reserve: 74555.25 }, boss)).status, 200);
assert.equal((await call('/report/day/2026-11-01', 'PUT', { bbj_main: 1000, bbj_reserve: 74100, bbj_paid: 271000 }, boss)).status, 200);
assert.equal((await call('/report/day/2026-11-02', 'PUT', { revenue: -5 }, boss)).status, 400);
assert.equal((await call('/report/day/2026-12-31', 'PUT', { revenue: 5 }, boss)).status, 400, 'no future days');
let rep = (await call('/report?from=2026-11-01&to=2026-11-03', 'GET', null, boss)).body;
assert.deepEqual(rep.days.map((d) => d.day), ['2026-11-01', '2026-11-02', '2026-11-03']);
const r2 = rep.days[1];
assert.equal(r2.revenue, 85000); assert.deepEqual(r2.table_revenue, { T1: 50000, T3: 35000 }); assert.equal(r2.bbj_main, 273962.25); assert.equal(r2.bbj_reserve, 74555.25); assert.equal(r2.updated_by, 'Boss');
assert.equal(r2.table_seconds, 21.5 * 3600 + 8 * 3600, 'T1 13:00 → 10:30 next morning, T3 8 h');
assert.deepEqual(r2.tables, ['T1', 'T3']);
assert.equal(r2.visitors, 3); assert.equal(r2.members, 2); assert.equal(r2.sessions, 3); assert.equal(r2.buy_in, 35000); assert.equal(r2.cash_out, 32000);
assert.equal(r2.levels['50 / 100 NLH'].table_seconds, r2.table_seconds);
assert.equal(rep.totals.revenue, 85000); assert.equal(rep.totals.entered_days, 1);
{ const t3 = rep.totals.tables.T3; assert.equal(t3.revenue, 35000); assert.equal(t3.table_seconds, 8 * 3600); assert.equal(t3.days, 1); assert.equal(t3.bb_hours, 800, '8 h × BB 100'); }
// Clearing one table keeps the other; the BBJ board is untouched.
assert.equal((await call('/report/day/2026-11-02', 'PUT', { tables: { T3: '' } }, boss)).status, 200);
let chk = (await call('/report?from=2026-11-02&to=2026-11-02', 'GET', null, boss)).body.days[0];
assert.equal(chk.revenue, 50000); assert.equal(chk.bbj_main, 273962.25);
await call('/report/day/2026-11-02', 'PUT', { tables: { T3: 35000 } }, boss);
// 10-31 board 344,000 → 11-01 board 75,100 after paying 271,000 (growth 2,100) → 11-02 board 348,517.50 (growth 273,417.50).
assert.equal(rep.days[0].bbj_growth, 2100); assert.equal(rep.days[1].bbj_growth, 273417.5);
assert.deepEqual(rep.bbj, { as_of: '2026-11-02', main: 273962.25, reserve: 74555.25, before: 344000, paid: 271000, growth: 275517.5 });
const op2 = (await call('/operation?day=2026-11-02', 'GET', null, boss)).body;
assert.deepEqual(op2.bbj, { day: '2026-11-02', main: 273962.25, reserve: 74555.25 }, 'Live Operation shows the latest board');
// A level change while the table runs splits the table hours.
clock = at('2026-11-03 11:30:00'); tables[1].blinds = '100 / 200'; await save();
clock = at('2026-11-03 12:30:00');
rep = (await call('/report?from=2026-11-03&to=2026-11-03', 'GET', null, boss)).body;
assert.equal(rep.days[0].levels['50 / 100 NLH'].table_seconds, 3600 + 2 * 3600, 'T2 10:30–11:30 + T1 10:30–12:30');
assert.equal(rep.days[0].levels['100 / 200 NLH'].table_seconds, 3600, 'T2 11:30–12:30');

// Master fixes: list runs, change times, delete a table opened by mistake.
assert.equal((await call('/operation/runs?day=2026-11-02', 'GET', null, maria2)).status, 403);
let runs = (await call('/operation/runs?day=2026-11-02', 'GET', null, boss)).body.runs;
const t3run = runs.find((r) => r.table_name === 'T3');
assert.equal(t3run.seconds, 8 * 3600); assert.equal(t3run.sessions, 0);
assert.equal((await call('/operation/runs/update', 'POST', { run_key: t3run.run_key, opened_at: at('2026-11-02 15:00:00') / 1000, closed_at: at('2026-11-02 14:00:00') / 1000 }, boss)).status, 400);
assert.equal((await call('/operation/runs/update', 'POST', { run_key: t3run.run_key, opened_at: at('2026-11-02 15:00:00') / 1000, closed_at: at('2026-11-02 22:00:00') / 1000 }, boss)).status, 200);
assert.equal((await call('/report?from=2026-11-02&to=2026-11-02', 'GET', null, boss)).body.days[0].table_seconds, 21.5 * 3600 + 7 * 3600);
assert.equal((await call('/operation/runs/delete', 'POST', { run_key: t3run.run_key }, boss)).status, 200);
assert.equal((await call('/report?from=2026-11-02&to=2026-11-02', 'GET', null, boss)).body.days[0].table_seconds, 21.5 * 3600, 'T3 removed');

// History Log: master only; PPM actions, logins and fixes are all there.
assert.equal((await call('/audit', 'GET', null, maria2)).status, 403);
const log = (await call('/audit?limit=200', 'GET', null, boss)).body;
const acts = new Set(log.entries.map((e) => e.action));
for (const a of ['staff.login', 'ppm.table_open', 'ppm.table_close', 'ppm.seat', 'ppm.level', 'table.run', 'report.day']) assert.ok(acts.has(a), 'logged ' + a);
assert.ok(log.entries.some((e) => e.action === 'ppm.seat' && /Ann sat at T1 #2 · buy-in 8,000/.test(e.detail)));
assert.ok(log.actors.includes('Boss'));
const ppmOnly = (await call('/audit?category=ppm', 'GET', null, boss)).body.entries;
assert.ok(ppmOnly.length && ppmOnly.every((e) => e.action.startsWith('ppm.')));
await call('/login', 'POST', { username: 'Maria', password: 'nope' });
assert.equal((await call('/audit?category=login&q=Maria', 'GET', null, boss)).body.entries[0].action, 'staff.login_failed');
{ // ppmChanges: leave with cash-out, add chips, rest, seat and table moves.
  const { ppmChanges } = await import('./audit.mjs');
  const seat = (id, m, st = 'seated', buy = 1000, start = 'S') => ({ id, status: m ? st : 'idle', memberId: m || '', buyInAmount: buy, sessionStart: m ? start : null });
  const tb = (id, name, seats, sessions = []) => ({ id, name, isRunning: true, gameType: 'NLH', blinds: '50 / 100', seats: Array.from({ length: 9 }, (_, j) => seats[j + 1] || seat(j + 1)), sessions });
  const a = [tb(1, 'T1', { 1: seat(1, 'Wei'), 2: seat(2, 'Bob'), 3: seat(3, 'Ann'), 4: seat(4, 'Kim') }), tb(2, 'T2', {})];
  const b = [tb(1, 'T1', { 2: seat(2, 'Bob', 'rest'), 3: seat(3, 'Ann', 'seated', 3000), 6: seat(6, 'Kim') }, [{ seatId: 1, memberId: 'Wei', buyInAmount: 1000, cashOutAmount: 4000 }]), tb(2, 'T2', { 5: seat(5, 'Joe', 'seated', 2000) })];
  b[1].seats[6] = seat(7, 'Wei', 'seated', 4000, 'S2'); a[0].seats[0] = seat(1, 'Wei'); b[0].sessions = [{ seatId: 1, memberId: 'Wei', buyInAmount: 1000, cashOutAmount: 4000 }];
  const ch = ppmChanges(a, b).map((c) => c.action + ': ' + c.detail);
  assert.ok(ch.includes('ppm.change_table: Wei: T1 #1 → T2 #7 with 4,000 chips (cashed out 4,000 at T1)'), ch.join('\n'));
  assert.ok(ch.includes('ppm.change_seat: Kim: T1 #4 → T1 #6'));
  assert.ok(ch.includes('ppm.rest: Bob at T1 #2 on a break'));
  assert.ok(ch.includes('ppm.add_chips: Ann at T1 #3 added 2,000 · total 3,000'));
  assert.ok(ch.includes('ppm.seat: Joe sat at T2 #5 · buy-in 2,000'));
  assert.ok(!ch.some((c) => c.startsWith('ppm.leave')), 'a move is not a leave');
  const c = structuredClone(b); c[1].seats[4] = seat(5); c[1].sessions = [{ seatId: 5, memberId: 'Joe', buyInAmount: 2000, cashOutAmount: 500 }];
  assert.deepEqual(ppmChanges(b, c).map((x) => x.detail), ['Joe left T2 #5 · buy-in 2,000 · cash-out 500 · W/L −1,500']);
}

// Telegram lineup: any staff account; players counted by nationality.
{ await call('/members/000001', 'PUT', { nationality: 'Taiwanese' }, boss);
  const a = (await call('/announce', 'GET', null, maria2)).body;
  const t1 = a.tables.find((t) => t.name === 'T1');
  assert.ok(t1, JSON.stringify(a)); assert.equal(t1.number, '1'); assert.equal(t1.players, 2); assert.equal(t1.open_seats, 7);
  assert.deepEqual(t1.nationalities, [{ nationality: 'Taiwanese', count: 1 }, { nationality: '', count: 1 }]);
  assert.equal((await call('/announce', 'POST', {}, maria2)).status, 200);
  assert.equal((await call('/announce', 'GET', null, maria2)).body.last_copy.actor, 'Maria'); }
console.log('PASS operation: managers only, noon cut-off, early opening, live tables, operating and table hours, visitors, buy-in live + finished, cash-out, history, report with revenue/BBJ/levels, master table-run fixes, history log, telegram lineup');
