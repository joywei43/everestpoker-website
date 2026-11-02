import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker from './worker.mjs';
import { staffSql } from './create-staff.mjs';

// In-memory D1 stand-in built on node:sqlite.
const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const stmt = (q) => { let args = []; return {
  bind(...v) { args = v; return this; },
  async first() { return sql.prepare(q).get(...args) || null; },
  async all() { return { results: sql.prepare(q).all(...args) }; },
  async run() { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; }
}; };
const DB = { prepare: stmt, async batch(list) { sql.exec('BEGIN'); try { const out = []; for (const s of list) out.push(await s.run()); sql.exec('COMMIT'); return out; } catch (e) { sql.exec('ROLLBACK'); throw e; } } };
const env = { DB, ADMIN_PASSWORD: 'test', MASTER_USERS: 'admin01' };
const call = async (path, method = 'GET', data, token) => {
  const res = await worker.fetch(new Request('https://api.test' + path, { method, headers: { Origin: 'https://everestpokerroom.com', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }), env);
  return { status: res.status, body: await res.json() };
};
const manila = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

assert.equal((await call('/members')).status, 401, 'member API needs login');
const { body: { token } } = await call('/login', 'POST', { username: 'admin01', password: 'test' });

// Groups are seeded.
const groups = (await call('/groups', 'GET', null, token)).body.groups;
assert.deepEqual(groups.map((g) => g.name), ['Hee', 'Dee', 'SK', 'Patrick', 'JOY', 'In-House']);
assert.equal(groups.find((g) => g.id === 'inhouse').owner, 'Marketing');

// Create members.
let r = await call('/members', 'POST', { surname: 'Chen', family_name: 'Wei-Lun', nickname: 'Wei', group_id: 'hee', staff: 'Maria' }, token);
assert.equal(r.status, 200); assert.equal(r.body.member_no, 'EV-000001');
r = await call('/members', 'POST', { nickname: 'Tiger', staff: 'Maria' }, token);
assert.equal(r.body.member_no, 'EV-000002');
assert.equal((await call('/members', 'POST', { nickname: 'x', group_id: 'nope' }, token)).status, 400);

// Import from the Google Sheet export.
r = await call('/members/import', 'POST', { staff: 'K. Lim', rows: [
  { surname: 'Kim', family_name: 'Min-jun', nickname: 'MJ', passport_id: 'M1234567', group: 'Dee' },
  { surname: 'Kim', family_name: 'Again', passport_id: 'M1234567' },
  { email: 'no-name@example.com' },
  { member_no: 'EV-000900', surname: 'Old', family_name: 'Member', group: 'Nobody' }
] }, token);
assert.equal(r.body.created, 2); assert.equal(r.body.skipped, 1); assert.equal(r.body.errors.length, 2);
const mj = (await call('/members?q=MJ', 'GET', null, token)).body.members[0];
assert.equal(mj.group_name, 'Dee'); assert.equal(mj.passport_last4, '4567'); assert.ok(!('passport_id' in mj), 'full passport never leaves the API');
assert.equal((await call('/members?group=unassigned', 'GET', null, token)).body.total, 2);

// PPM save copies finished sessions into play time, matched by member number or nickname.
const past = '2026-10-01 19:00:00', pastEnd = '2026-10-01 23:30:00';
const seats = () => Array.from({ length: 9 }, (_, j) => ({ id: j + 1, status: 'idle', memberId: '' }));
const tables = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, name: ['T1', 'T2', 'T3', 'T5'][i], isRunning: i === 0, blinds: '50 / 100', gameType: 'NLH', seats: seats(), sessions: [] }));
tables[0].sessions = [
  { date: '2026-10-01', tableId: 1, tableName: 'T1', seatId: 1, memberId: 'EV-000001', startTime: past, endTime: pastEnd, activeSeconds: 14400, restSeconds: 1800, durationHMS: '04:00:00', buyInDisplay: '20000', buyInAmount: 20000, transferNote: null },
  { date: '2026-10-01', tableId: 1, tableName: 'T1', seatId: 2, memberId: 'mj', startTime: past, endTime: pastEnd, activeSeconds: 7200, restSeconds: 0, durationHMS: '02:00:00', buyInDisplay: '5000', buyInAmount: 5000, transferNote: null },
  { date: '2026-10-01', tableId: 1, tableName: 'T1', seatId: 3, memberId: 'Walkin Bob', startTime: past, endTime: pastEnd, activeSeconds: 3600, restSeconds: 0, durationHMS: '01:00:00', buyInDisplay: '3000', buyInAmount: 3000, transferNote: null }
];
let ppm = await call('/ppm', 'PUT', { version: 0, tables }, token);
assert.equal(ppm.status, 200);
let chen = (await call('/members/EV-000001', 'GET', null, token)).body;
assert.equal(chen.sessions.length, 1); assert.equal(chen.sessions[0].group_id, 'hee'); assert.equal(chen.sessions[0].blinds, '50 / 100'); assert.equal(chen.sessions[0].buy_in, 20000);
assert.equal(chen.stats.all.secs, 14400);
// Saving again does not duplicate.
ppm = await call('/ppm', 'PUT', { version: 1, tables }, token);
assert.equal((await call('/members/EV-000001', 'GET', null, token)).body.sessions.length, 1);

// Change group: past hours stay with Hee, later hours go to JOY.
assert.equal((await call('/members/EV-000001/group', 'POST', { group_id: 'joy', staff: 'K. Lim', note: 'Host request' }, token)).status, 200);
const later = Date.now() + 60e3;
tables[0].sessions.push({ date: 'x', tableId: 1, tableName: 'T1', seatId: 4, memberId: 'EV-000001', startTime: manila(later), endTime: manila(later + 3600e3), activeSeconds: 3000, restSeconds: 600, buyInAmount: 10000, transferNote: null });
ppm = await call('/ppm', 'PUT', { version: 2, tables }, token);
chen = (await call('/members/EV-000001', 'GET', null, token)).body;
assert.deepEqual(chen.sessions.map((s) => s.group_id).sort(), ['hee', 'joy']);
assert.equal(chen.group_history[0].group_name, 'JOY'); assert.equal(chen.group_history[1].group_name, 'Hee');

// Rewards: charged to the group at the time, voided not deleted.
assert.equal((await call('/members/EV-000001/rewards', 'POST', { type: 'hotel', amount: 6500, detail: 'Midori 1 night', recorded_by: 'Maria', approved_by: 'K. Lim', date: '2026-10-05' }, token)).status, 200);
assert.equal((await call('/members/EV-000001/rewards', 'POST', { type: 'promo_cash', amount: 5000, recorded_by: 'Maria' }, token)).status, 200);
assert.equal((await call('/members/EV-000001/rewards', 'POST', { type: 'reward_code', amount: 1, recorded_by: 'Maria' }, token)).status, 400);
assert.equal((await call('/members/EV-000001/rewards', 'POST', { type: 'promo_cash', amount: 10.5, recorded_by: 'Maria' }, token)).status, 400);
chen = (await call('/members/EV-000001', 'GET', null, token)).body;
const hotel = chen.rewards.find((x) => x.type === 'hotel'), cash = chen.rewards.find((x) => x.type === 'promo_cash');
assert.equal(hotel.group_id, 'hee'); assert.equal(cash.group_id, 'joy');
assert.equal(chen.stats.all.rewards, 11500);
assert.equal((await call(`/rewards/${cash.id}/void`, 'POST', { staff: 'K. Lim' }, token)).status, 400, 'reason required');
assert.equal((await call(`/rewards/${cash.id}/void`, 'POST', { staff: 'K. Lim', reason: 'Entered twice' }, token)).status, 200);
chen = (await call('/members/EV-000001', 'GET', null, token)).body;
assert.equal(chen.stats.all.rewards, 6500); assert.ok(chen.rewards.find((x) => x.id === cash.id).voided);

// Group summary for a date range.
let sum = (await call('/groups/summary?from=2026-09-01&to=2027-12-31', 'GET', null, token)).body;
const hee = sum.groups.find((g) => g.id === 'hee'), joy = sum.groups.find((g) => g.id === 'joy'), dee = sum.groups.find((g) => g.id === 'dee');
assert.equal(hee.seconds, 14400); assert.equal(joy.seconds, 3000); assert.equal(dee.seconds, 7200);
assert.equal(hee.players[0].moved_to, 'JOY'); assert.equal(joy.players[0].moved_to, null);
assert.equal(hee.rewards, 6500); assert.equal(sum.unmatched_sessions, 1); assert.equal(sum.unmatched_seconds, 3600);

// Unmatched PPM names can be linked to a member afterwards.
const refs = (await call('/sessions/unmatched', 'GET', null, token)).body.refs;
assert.equal(refs[0].member_ref, 'Walkin Bob');
r = await call('/sessions/link', 'POST', { member_ref: 'Walkin Bob', member_no: 'EV-000002', staff: 'Maria' }, token);
assert.equal(r.status, 409); assert.equal(r.body.code, 'name_mismatch', 'Walkin Bob does not look like Tiger');
assert.equal((await call('/sessions/link', 'POST', { member_ref: 'Walkin Bob', member_no: 'EV-000002', staff: 'Maria', confirm: true }, token)).body.linked, 1);
assert.equal((await call('/sessions/unmatched', 'GET', null, token)).body.refs.length, 0);
// Tiger had no group when he played; his first group takes those hours.
assert.equal((await call('/members/EV-000002/group', 'POST', { group_id: 'sk', staff: 'K. Lim' }, token)).status, 200);
sum = (await call('/groups/summary?from=2026-09-01&to=2027-12-31', 'GET', null, token)).body;
assert.equal(sum.groups.find((g) => g.id === 'sk').seconds, 3600);

// Profile edits and audit trail.
assert.equal((await call('/members/EV-000001', 'PUT', { staff_notes: 'Prefers seat 1', status: 'active', staff: 'Maria' }, token)).status, 200);
assert.equal((await call('/members/EV-000001', 'PUT', { status: 'deleted', staff: 'Maria' }, token)).status, 400);
chen = (await call('/members/EV-000001', 'GET', null, token)).body;
assert.equal(chen.member.staff_notes, 'Prefers seat 1');
assert.ok(chen.audit.some((a) => a.action === 'member.group') && chen.audit.some((a) => a.action === 'reward.void'));

// Public registration replaces the Google Sheet: 21+ only, rate limited.
const reg = { surname: 'Young', familyName: 'Player', birthday: '2010-01-01', agreedTerms: true, agreedAge: true, agreedPolicy: true };
assert.equal((await call('/register', 'POST', reg)).status, 400);
r = await call('/register', 'POST', { ...reg, birthday: '1990-05-05' });
assert.equal(r.status, 200); assert.match(r.body.member_no, /^EV-\d{6}$/);
for (let i = 0; i < 3; i++) await call('/register', 'POST', { ...reg, birthday: '1990-05-05' });
assert.equal((await call('/register', 'POST', { ...reg, birthday: '1990-05-05' })).status, 429);

// Search for the PPM autocomplete.
const hits = (await call('/members?q=wei&limit=8', 'GET', null, token)).body.members;
assert.equal(hits[0].member_no, 'EV-000001');
assert.equal((await call('/members/EV-999999', 'GET', null, token)).status, 404);


// Staff accounts: each person signs in with their own name; the log records who did what.
assert.equal((await call('/me', 'GET', null, token)).body.user, 'admin01');
sql.exec(await staffSql(['ADMIN01:secret-admin', 'Geraldine:secret-g', 'Joy:secret-j']));
assert.ok(!JSON.stringify(sql.prepare('SELECT * FROM staff').all()).includes('secret-g'), 'no plain-text passwords');
assert.equal((await call('/login', 'POST', { username: 'admin01', password: 'test' })).status, 401, 'old shared password stops once ADMIN01 exists');
assert.equal((await call('/login', 'POST', { username: 'Geraldine', password: 'wrong' })).status, 401);
assert.equal((await call('/login', 'POST', { username: 'admin01', password: 'secret-admin' })).status, 200, 'usernames are not case sensitive');
const g = (await call('/login', 'POST', { username: 'geraldine', password: 'secret-g' })).body;
assert.equal(g.user, 'Geraldine');
assert.equal((await call('/me', 'GET', null, g.token)).body.user, 'Geraldine');
assert.equal((await call('/members/EV-000001', 'PUT', { staff_notes: 'Regular on Fridays', staff: 'Someone else' }, g.token)).status, 200);
chen = (await call('/members/EV-000001', 'GET', null, g.token)).body;
assert.equal(chen.audit[0].actor, 'Geraldine', 'log shows the signed-in person, not a typed name');
// Managers approve and edit promotions; group changes, voids, imports, suspensions and accounts are master only.
assert.equal((await call('/members/EV-000001/group', 'POST', { group_id: 'dee' }, g.token)).status, 403);
assert.equal((await call('/members/import', 'POST', { rows: [] }, g.token)).status, 200, 'managers can import');
assert.equal((await call('/members/EV-000001', 'PUT', { status: 'suspended' }, g.token)).status, 403);
assert.equal((await call('/staff', 'GET', null, g.token)).status, 403);
assert.equal((await call('/me', 'GET', null, token)).body.role, 'master');
assert.equal((await call('/logout', 'POST', {}, g.token)).status, 200);
assert.equal((await call('/me', 'GET', null, g.token)).status, 401);
sql.exec("UPDATE staff SET active=0 WHERE username='Joy'");
assert.equal((await call('/login', 'POST', { username: 'Joy', password: 'secret-j' })).status, 401, 'disabled account cannot sign in');

// Two levels: staff record, managers approve and make the big changes.
sql.exec(await staffSql(['Maria:secret-m:staff']));
const maria = (await call('/login', 'POST', { username: 'maria', password: 'secret-m' })).body;
assert.equal(maria.role, 'staff'); assert.equal((await call('/me', 'GET', null, maria.token)).body.role, 'staff');
const boss = (await call('/login', 'POST', { username: 'ADMIN01', password: 'secret-admin' })).body;
assert.equal(boss.role, 'master');
const before = (await call('/members/EV-000001', 'GET', null, boss.token)).body.stats.all.rewards;
r = await call('/members/EV-000001/rewards', 'POST', { type: 'hotel', amount: 4000, detail: 'Midori 1 night', recorded_by: 'Maria' }, maria.token);
assert.equal(r.status, 200); assert.equal(r.body.approved, false);
chen = (await call('/members/EV-000001', 'GET', null, boss.token)).body;
assert.equal(chen.stats.all.rewards, before, 'pending reward not in cost yet'); assert.equal(chen.stats.all.rewards_pending, 4000);
const pend = (await call('/rewards/pending', 'GET', null, maria.token)).body.rewards;
assert.equal(pend.length, 1); assert.equal(pend[0].member_no, 'EV-000001');
assert.equal((await call(`/rewards/${pend[0].id}/approve`, 'POST', {}, maria.token)).status, 403);
assert.equal((await call(`/rewards/${pend[0].id}/void`, 'POST', { reason: 'x' }, maria.token)).status, 403);
assert.equal((await call('/members/EV-000001/group', 'POST', { group_id: 'dee' }, maria.token)).status, 403);
assert.equal((await call('/members/import', 'POST', { rows: [] }, maria.token)).status, 403);
assert.equal((await call('/members/EV-000001', 'PUT', { status: 'banned' }, maria.token)).status, 403);
assert.equal((await call('/members/EV-000001', 'PUT', { staff_notes: 'Seat 9 today', status: 'active' }, maria.token)).status, 200, 'staff can edit notes');
assert.equal((await call('/members', 'POST', { nickname: 'Walk-in Ana' }, maria.token)).status, 200, 'staff can add members');
assert.equal((await call(`/rewards/${pend[0].id}/approve`, 'POST', {}, boss.token)).status, 200);
chen = (await call('/members/EV-000001', 'GET', null, boss.token)).body;
assert.equal(chen.stats.all.rewards, before + 4000); assert.equal(chen.stats.all.rewards_pending, 0);
assert.equal(chen.rewards.find((x) => x.id === pend[0].id).approved_by, 'ADMIN01');
r = await call('/members/EV-000001/rewards', 'POST', { type: 'free_chip', amount: 1000, recorded_by: 'ADMIN01' }, boss.token);
assert.equal(r.body.approved, true, 'manager entries are approved at once');

// Photos: staff upload a small image, it shows on the profile and in the member's own app.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
assert.equal((await call('/members/EV-000001/photo', 'PUT', { data: 'data:text/html;base64,PHNjcmlwdD4=' }, maria.token)).status, 400);
assert.equal((await call('/members/EV-000001/photo', 'PUT', { data: 'data:image/png;base64,' + 'A'.repeat(700000) }, maria.token)).status, 413);
assert.equal((await call('/members/EV-000001/photo', 'PUT', { data: png }, maria.token)).status, 200);
assert.equal((await call('/members/EV-000001', 'GET', null, maria.token)).body.member.has_photo, true);
assert.equal((await call('/members/EV-000001/photo', 'GET', null, maria.token)).body.data, png);
assert.equal((await call('/members?q=EV-000001', 'GET', null, maria.token)).body.members[0].has_photo, true);
assert.equal((await call('/members/EV-000001/photo/remove', 'POST', {}, maria.token)).status, 200);
assert.equal((await call('/members/EV-000001/photo', 'GET', null, maria.token)).status, 404);

// Staff accounts from the console: managers only; new accounts sign in; disabling signs out.
assert.equal((await call('/staff', 'GET', null, maria.token)).status, 403);
assert.equal((await call('/staff', 'POST', { username: 'Rina', password: '123', role: 'staff' }, boss.token)).status, 400);
assert.equal((await call('/staff', 'POST', { username: 'Rina', password: 'rina-pass', role: 'staff' }, boss.token)).status, 200);
assert.equal((await call('/staff', 'POST', { username: 'rina', password: 'rina-pass' }, boss.token)).status, 409);
const rina = (await call('/login', 'POST', { username: 'Rina', password: 'rina-pass' })).body;
assert.equal(rina.role, 'staff');
assert.equal((await call('/staff/Rina', 'PUT', { role: 'admin' }, boss.token)).status, 200);
assert.equal((await call('/me', 'GET', null, rina.token)).body.role, 'admin', 'role change applies at once');
assert.equal((await call('/staff/Rina', 'PUT', { active: false }, boss.token)).status, 200);
assert.equal((await call('/me', 'GET', null, rina.token)).status, 401, 'disabled account is signed out');
assert.equal((await call('/login', 'POST', { username: 'Rina', password: 'rina-pass' })).status, 401);
assert.equal((await call('/staff/ADMIN01', 'PUT', { active: false }, boss.token)).status, 400, 'cannot disable yourself');
assert.equal((await call('/staff/Joy', 'PUT', { active: true, password: 'new-joy-pass' }, boss.token)).status, 200);
assert.equal((await call('/login', 'POST', { username: 'joy', password: 'new-joy-pass' })).status, 200);
const staffList = (await call('/staff', 'GET', null, boss.token)).body.staff;
assert.ok(staffList.length >= 5 && !JSON.stringify(staffList).includes('pw_hash'));
assert.equal(staffList.find((x) => x.username === 'ADMIN01').role, 'master');
assert.equal((await call('/staff/ADMIN01', 'PUT', { role: 'staff' }, boss.token)).status, 400, 'master is fixed in settings');
assert.equal((await call('/staff/ADMIN01/delete', 'POST', {}, boss.token)).status, 400, 'master cannot be deleted');
assert.equal((await call('/staff/Rina/delete', 'POST', {}, maria.token)).status, 403);
assert.equal((await call('/staff/Rina/delete', 'POST', {}, boss.token)).status, 200);
assert.ok(!(await call('/staff', 'GET', null, boss.token)).body.staff.some((x) => x.username === 'Rina'));
assert.equal((await call('/login', 'POST', { username: 'Rina', password: 'rina-pass' })).status, 401);
const geraldine = (await call('/login', 'POST', { username: 'Geraldine', password: 'secret-g' })).body;
r = await call('/members/EV-000001/rewards', 'POST', { type: 'hotel', amount: 100, recorded_by: 'Maria' }, maria.token);
const pid = (await call('/rewards/pending', 'GET', null, geraldine.token)).body.rewards[0].id;
assert.equal((await call(`/rewards/${pid}/void`, 'POST', { reason: 'x' }, geraldine.token)).status, 403, 'managers cannot void');
assert.equal((await call(`/rewards/${pid}/approve`, 'POST', {}, geraldine.token)).status, 200, 'managers approve');

// Master can change a member number; records stay, the old number still works in PPM.
assert.equal((await call('/members/EV-000002/number', 'POST', { member_no: 'VIP-007' }, geraldine.token)).status, 403);
assert.equal((await call('/members/EV-000002/number', 'POST', { member_no: 'EV-000001' }, boss.token)).status, 409);
assert.equal((await call('/members/EV-000002/number', 'POST', { member_no: 'bad no!' }, boss.token)).status, 400);
const tigerBefore = (await call('/members/EV-000002', 'GET', null, boss.token)).body;
r = await call('/members/EV-000002/number', 'POST', { member_no: 'vip-007' }, boss.token);
assert.equal(r.status, 200); assert.equal(r.body.member_no, 'VIP-007');
const tigerAfter = (await call('/members/VIP-007', 'GET', null, boss.token)).body;
assert.equal(tigerAfter.stats.all.secs, tigerBefore.stats.all.secs, 'play time stays');
assert.equal(tigerAfter.group_history.length, tigerBefore.group_history.length);
assert.equal((await call('/members/EV-000002', 'GET', null, boss.token)).body.moved_to, 'VIP-007');
assert.ok(tigerAfter.audit.some((a) => a.action === 'member.number' && a.detail === 'EV-000002 → VIP-007'));
assert.equal((await call('/members', 'POST', { nickname: 'Copycat', member_no: 'EV-000002' }, maria.token)).status, 409, 'retired numbers are not reused by staff');
const fresh = (await call('/members', 'POST', { nickname: 'Fresh' }, boss.token)).body.member_no;
assert.notEqual(fresh, 'EV-000002');

// Six digits are enough: EV- is added automatically everywhere.
r = await call('/members', 'POST', { nickname: 'Six', member_no: '444444' }, boss.token);
assert.equal(r.body.member_no, 'EV-444444');
assert.equal((await call('/members', 'POST', { nickname: 'Dup', member_no: 'ev444444' }, boss.token)).status, 409);
assert.equal((await call('/members/444444', 'GET', null, boss.token)).body.member.nickname, 'Six');
assert.equal((await call('/members?q=444444', 'GET', null, boss.token)).body.members[0].member_no, 'EV-444444');
const t2 = structuredClone(tables); t2[0].sessions = [{ seatId: 5, memberId: 'Bob 6', startTime: '2026-10-30 21:30:00', endTime: '2026-10-30 23:30:00', activeSeconds: 7200, restSeconds: 0, buyInAmount: 1000 },
  { seatId: 6, memberId: '444444', startTime: '2026-10-30 20:00:00', endTime: '2026-10-30 21:00:00', activeSeconds: 3600, restSeconds: 0, buyInAmount: 1000 },
  { seatId: 7, memberId: 'Six (444444)', startTime: '2026-10-30 18:00:00', endTime: '2026-10-30 18:30:00', activeSeconds: 1800, restSeconds: 0, buyInAmount: 1000 }];
const ppmNow = (await call('/ppm', 'GET', null, boss.token)).body;
assert.equal((await call('/ppm', 'PUT', { version: ppmNow.version, tables: t2 }, boss.token)).status, 200);
assert.equal((await call('/members/EV-444444', 'GET', null, boss.token)).body.stats.all.secs, 5400, 'PPM seat typed as six digits, or picked as "Six (444444)", matches');
assert.equal((await call('/sessions/link', 'POST', { member_ref: 'Bob 6', member_no: '444444', confirm: true }, boss.token)).body.linked, 1, 'unmatched names link by six digits');

// Players still at the table: listed in Unmatched, can be linked before they leave.
let ppmLive = (await call('/ppm', 'GET', null, boss.token)).body;
const t3 = structuredClone(ppmLive.tables);
t3[1].isRunning = true;
t3[1].seats[0] = { ...t3[1].seats[0], status: 'seated', memberId: 'ELLY', sessionStart: '2026-11-02 18:24:42', activeSeconds: 600, restSeconds: 0, lastActiveStart: Date.now() - 60000, buyInAmount: 10000 };
t3[1].seats[1] = { ...t3[1].seats[1], status: 'rest', memberId: '444444', sessionStart: '2026-11-02 19:00:00', activeSeconds: 100, restSeconds: 50, lastActiveStart: null, buyInAmount: 5000 };
assert.equal((await call('/ppm', 'PUT', { version: ppmLive.version, tables: t3 }, boss.token)).status, 200);
let um = (await call('/sessions/unmatched', 'GET', null, maria.token)).body;
assert.equal(um.seated.length, 2, 'every seated player is listed');
assert.equal(um.seated[0].ref, 'ELLY', 'unmatched first'); assert.equal(um.seated[0].auto, null);
assert.equal(um.seated[1].auto.member_no, 'EV-444444', 'typed 444444 shows its automatic match');
const sixNow = (await call('/members/EV-444444', 'GET', null, boss.token)).body;
assert.equal(sixNow.playing.length, 1, 'seated member shows as playing now'); assert.equal(sixNow.playing[0].table, 'T2'); assert.equal(sixNow.playing[0].status, 'rest'); assert.equal(sixNow.playing[0].buy_in, 5000); assert.ok(um.seated[0].active_seconds >= 650);
// Guard: EV-444444 is already sitting at seat 2, so ELLY cannot be linked to that number.
r = await call('/sessions/link-seat', 'POST', { seat_key: um.seated[0].seat_key, member_no: '444444' }, maria.token);
assert.equal(r.status, 409); assert.equal(r.body.code, 'already_seated'); assert.match(r.body.error, /S2/);
assert.equal((await call('/members', 'POST', { nickname: 'Eleanor', surname: 'Wu', member_no: '777777' }, boss.token)).status, 200);
r = await call('/sessions/link-seat', 'POST', { seat_key: um.seated[0].seat_key, member_no: '777777' }, maria.token);
assert.equal(r.body.code, 'name_mismatch', 'ELLY vs Eleanor asks for confirmation');
assert.equal((await call('/sessions/link-seat', 'POST', { seat_key: um.seated[0].seat_key, member_no: '777777', confirm: true }, maria.token)).body.member_no, 'EV-777777');
um = (await call('/sessions/unmatched', 'GET', null, maria.token)).body;
assert.equal(um.seated[0].linked.member_no, 'EV-777777');
// A wrong seat link can be changed.
assert.equal((await call('/sessions/unlink-seat', 'POST', { seat_key: um.seated[0].seat_key }, maria.token)).status, 200);
assert.equal((await call('/sessions/unmatched', 'GET', null, maria.token)).body.seated[0].linked, null);
await call('/sessions/link-seat', 'POST', { seat_key: um.seated[0].seat_key, member_no: '777777', confirm: true }, maria.token);

// A wrong automatic match can be overridden by a staff link.
um = (await call('/sessions/unmatched', 'GET', null, maria.token)).body;
const autoSeat = um.seated.find((x) => x.auto);
assert.equal((await call('/members', 'POST', { nickname: 'Real Owner', member_no: '888888' }, boss.token)).status, 200);
assert.equal((await call('/sessions/link-seat', 'POST', { seat_key: autoSeat.seat_key, member_no: '888888', confirm: true }, maria.token)).status, 200);
um = (await call('/sessions/unmatched', 'GET', null, maria.token)).body;
assert.equal(um.seated.find((x) => x.seat_key === autoSeat.seat_key).linked.member_no, 'EV-888888');
await call('/sessions/unlink-seat', 'POST', { seat_key: autoSeat.seat_key }, maria.token);
const before6 = (await call('/members/EV-777777', 'GET', null, boss.token)).body.stats.all.secs;
ppmLive = (await call('/ppm', 'GET', null, boss.token)).body;
const t4 = structuredClone(ppmLive.tables);
t4[1].sessions = [...(t4[1].sessions || []), { seatId: 1, memberId: 'ELLY', startTime: '2026-11-02 18:24:42', endTime: '2026-11-02 21:00:00', activeSeconds: 9000, restSeconds: 0, buyInAmount: 10000 }];
t4[1].seats[0] = { ...t4[1].seats[0], status: 'idle', memberId: '', sessionStart: null };
assert.equal((await call('/ppm', 'PUT', { version: ppmLive.version, tables: t4 }, boss.token)).status, 200);
const ev7 = (await call('/members/EV-777777', 'GET', null, boss.token)).body;
assert.equal(ev7.stats.all.secs, before6 + 9000, 'hours go to the linked member when the player leaves');
// Master can undo a wrong link on a finished session; it returns to Unmatched.
assert.equal((await call(`/sessions/${ev7.sessions[0].id}/unlink`, 'POST', {}, maria.token)).status, 403);
assert.equal((await call(`/sessions/${ev7.sessions[0].id}/unlink`, 'POST', {}, boss.token)).status, 200);
assert.ok((await call('/sessions/unmatched', 'GET', null, maria.token)).body.refs.some((x) => x.member_ref === 'ELLY'));
// Overlap guard on finished sessions: EV-444444 played 18:24–21:00? no; Six played Bob 6 on 30 Oct 20–22, so 'ELLY' (2 Nov) is fine, but a clash is refused.
const t5 = structuredClone((await call('/ppm', 'GET', null, boss.token)).body);
t5.tables[2].sessions = [{ seatId: 3, memberId: 'Ghost', startTime: '2026-10-30 20:30:00', endTime: '2026-10-30 21:30:00', activeSeconds: 3600, restSeconds: 0, buyInAmount: 0 }];
await call('/ppm', 'PUT', { version: t5.version, tables: t5.tables }, boss.token);
r = await call('/sessions/link', 'POST', { member_ref: 'Ghost', member_no: '444444', confirm: true }, boss.token);
assert.equal(r.status, 409); assert.equal(r.body.code, 'overlap');
await call('/sessions/link', 'POST', { member_ref: 'ELLY', member_no: '777777', confirm: true }, boss.token);
assert.ok(!(await call('/sessions/unmatched', 'GET', null, maria.token)).body.refs.some((x) => x.member_ref === 'ELLY'));
// Master may give a retired number to someone else to fix a mistake; staff may not.
assert.equal((await call('/members/EV-444444/number', 'POST', { member_no: '444445' }, boss.token)).status, 200);
assert.equal((await call('/members', 'POST', { nickname: 'Fix', member_no: '444444' }, maria.token)).status, 409);
assert.equal((await call('/members', 'POST', { nickname: 'Fix', member_no: '444444' }, boss.token)).status, 200);
assert.equal((await call('/members/EV-444445/number', 'POST', { member_no: '444444' }, boss.token)).status, 409, 'number now in use');
assert.equal((await call('/members/EV-444445/number', 'POST', { member_no: 'bad no!' }, boss.token)).status, 400);
await call('/members/EV-444444/number', 'POST', { member_no: '444446' }, boss.token);
await call('/members/EV-444445/number', 'POST', { member_no: '444444' }, boss.token);

// Cash-out from PPM, History W/L, rest ratio data, manager corrections.
{
  const pp = (await call('/ppm', 'GET', null, boss.token)).body;
  const tt = structuredClone(pp.tables);
  tt[3].sessions = [
    { seatId: 1, memberId: '777777', startTime: '2026-10-20 20:00:00', endTime: '2026-10-20 23:00:00', activeSeconds: 9000, restSeconds: 1800, buyInAmount: 20000, cashOutAmount: 32000, busted: false },
    { seatId: 1, memberId: '777777', startTime: '2026-10-21 20:00:00', endTime: '2026-10-21 22:00:00', activeSeconds: 7200, restSeconds: 0, buyInAmount: 10000, cashOutAmount: 0, busted: true },
    { seatId: 2, memberId: '777777', startTime: '2026-10-22 20:00:00', endTime: '2026-10-22 21:00:00', activeSeconds: 3600, restSeconds: 0, buyInAmount: 5000 }
  ];
  assert.equal((await call('/ppm', 'PUT', { version: pp.version, tables: tt }, boss.token)).status, 200);
  let e7 = (await call('/members/EV-777777', 'GET', null, boss.token)).body;
  const s1 = e7.sessions.find((x) => x.play_date === '2026-10-20'), s2 = e7.sessions.find((x) => x.play_date === '2026-10-21'), s3 = e7.sessions.find((x) => x.play_date === '2026-10-22');
  assert.equal(s1.cash_out, 32000); assert.equal(s2.cash_out, 0); assert.equal(s2.busted, 1); assert.equal(s3.cash_out, null);
  const allBefore = e7.stats.all;
  assert.equal(allBefore.win_loss, 12000 - 10000, 'W/L = cash-out − buy-in on sessions with a cash-out');
  assert.equal(allBefore.busted, 1); assert.ok(allBefore.rest_secs >= 1800);
  assert.equal((await call(`/sessions/${s3.id}/cash-out`, 'POST', { cash_out: 7000 }, maria.token)).status, 403, 'staff cannot edit cash-out');
  assert.equal((await call(`/sessions/${s3.id}/cash-out`, 'POST', { cash_out: 7000 }, geraldine.token)).status, 200);
  e7 = (await call('/members/EV-777777', 'GET', null, boss.token)).body;
  assert.equal(e7.stats.all.win_loss, allBefore.win_loss + 2000); assert.equal(e7.stats.all.with_cash_out, allBefore.with_cash_out + 1);
  assert.equal((await call(`/sessions/${s3.id}/cash-out`, 'POST', { clear: true }, geraldine.token)).status, 200);
  assert.ok(e7.audit.some((a) => a.action === 'session.cash_out'));
}

// Group summary lists current members (even with 0 h) and players at a table now; master can correct a wrong group with past hours.
{
  const sm = (await call('/groups/summary?from=2026-01-01&to=2027-12-31', 'GET', null, boss.token)).body;
  const dee = sm.groups.find((g) => g.id === 'dee');
  assert.ok(dee.member_count >= 1); assert.ok(dee.players.some((p) => p.member_no === 'EV-000003' || p.seconds === 0) || dee.players.length >= dee.member_count);
  const owner = (await call('/members', 'POST', { nickname: 'Pat Guest', member_no: '121212', group_id: 'inhouse' }, boss.token)).body.member_no;
  const pp = (await call('/ppm', 'GET', null, boss.token)).body; const tt = structuredClone(pp.tables);
  tt[2].sessions = [{ seatId: 7, memberId: '121212', startTime: '2026-10-25 20:00:00', endTime: '2026-10-25 22:00:00', activeSeconds: 7200, restSeconds: 0, buyInAmount: 1000 }];
  await call('/ppm', 'PUT', { version: pp.version, tables: tt }, boss.token);
  let g2 = (await call('/groups/summary?from=2026-01-01&to=2027-12-31', 'GET', null, boss.token)).body;
  const inBefore = g2.groups.find((g) => g.id === 'inhouse').seconds, patBefore = g2.groups.find((g) => g.id === 'patrick').seconds;
  assert.equal((await call(`/members/${owner}/group`, 'POST', { group_id: 'patrick', move_past: true }, geraldine.token)).status, 403);
  await call(`/members/${owner}/group`, 'POST', { group_id: 'patrick' }, boss.token);
  g2 = (await call('/groups/summary?from=2026-01-01&to=2027-12-31', 'GET', null, boss.token)).body;
  assert.equal(g2.groups.find((g) => g.id === 'patrick').seconds, patBefore, 'normal change: past hours stay');
  assert.ok(g2.groups.find((g) => g.id === 'patrick').players.some((p) => p.member_no === owner && p.seconds === 0), 'current member listed with 0 h');
  await call(`/members/${owner}/group`, 'POST', { group_id: 'patrick', move_past: true, note: 'set up wrong' }, boss.token);
  g2 = (await call('/groups/summary?from=2026-01-01&to=2027-12-31', 'GET', null, boss.token)).body;
  assert.equal(g2.groups.find((g) => g.id === 'patrick').seconds, patBefore + 7200, 'correction moves past hours');
  assert.equal(g2.groups.find((g) => g.id === 'inhouse').seconds, inBefore - 7200);
}

// Same nickname: the nationality is shown after it.
{
  await call('/members', 'POST', { nickname: 'Twin', nationality: 'Taiwanese', member_no: '900001' }, boss.token);
  let hits = (await call('/members?q=twin', 'GET', null, boss.token)).body.members;
  assert.equal(hits[0].nick_label, 'Twin', 'unique nickname shown as is');
  const dup = await call('/members', 'POST', { nickname: 'twin', nationality: 'Korean', member_no: '900002' }, boss.token);
  assert.equal(dup.status, 409); assert.equal(dup.body.code, 'possible_duplicate'); assert.equal(dup.body.matches[0].member_no, 'EV-900001'); assert.deepEqual(dup.body.matches[0].why, ['nickname']);
  await call('/members', 'POST', { nickname: 'twin', nationality: 'Korean', member_no: '900002', confirm_duplicate: true }, boss.token);
  await call('/members', 'POST', { nickname: 'TWIN', member_no: '900003', confirm_duplicate: true }, boss.token);
  hits = (await call('/members?q=twin', 'GET', null, boss.token)).body.members;
  assert.deepEqual(hits.map((h) => h.nick_label).sort(), ['TWIN (EV-900003)', 'Twin (Taiwan)', 'twin (South Korea)']);
  assert.equal((await call('/members/900002', 'GET', null, boss.token)).body.member.nick_label, 'twin (South Korea)');
}

// New members get the smallest free number (gaps are filled, retired numbers skipped).
{
  const nx = (await call('/members/next-number', 'GET', null, maria.token)).body.member_no;
  const used = new Set(sql.prepare("SELECT member_no FROM members").all().map((r) => r.member_no));
  assert.ok(!used.has(nx), 'next number is free');
  const created = (await call('/members', 'POST', { nickname: 'Gap filler' }, maria.token)).body.member_no;
  assert.equal(created, nx, 'blank number takes the suggested one');
  const n = Number(nx.slice(3));
  for (let k = 1; k < n; k++) { const c = 'EV-' + String(k).padStart(6, '0'); assert.ok(used.has(c) || sql.prepare('SELECT 1 FROM member_number_history WHERE old_no=?').get(c), c + ' should be taken'); }
}

// Nationality: one spelling per country.
assert.equal((await call('/members/EV-444444', 'PUT', { nationality: 'Taiwanese' }, boss.token)).status, 200);
assert.equal((await call('/members/EV-444444', 'GET', null, boss.token)).body.member.nationality, 'Taiwan');
await call('/members/EV-444444', 'PUT', { nationality: '  korean ' }, boss.token);
assert.equal((await call('/members/EV-444444', 'GET', null, boss.token)).body.member.nationality, 'South Korea');
await call('/members/EV-444444', 'PUT', { nationality: 'Brazil' }, boss.token);
assert.equal((await call('/members/EV-444444', 'GET', null, boss.token)).body.member.nationality, 'Brazil', 'other countries kept as typed');
sql.exec("UPDATE members SET nationality='台灣' WHERE member_no='EV-444444'");
sql.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
assert.equal((await call('/members/EV-444444', 'GET', null, boss.token)).body.member.nationality, 'Taiwan', 'old rows cleaned on deploy');

{ // Remark on a new member is saved to the staff notes.
  const no = (await call('/members', 'POST', { nickname: 'Hyun', staff_notes: 'Prefers Table 3' }, boss.token)).body.member_no;
  assert.equal((await call('/members/' + no, 'GET', null, boss.token)).body.member.staff_notes, 'Prefers Table 3');
}
{ // Possible duplicates by phone; master merge and delete.
  await call('/members', 'POST', { nickname: 'Patrick P', phone: '+63 917 555 1234', member_no: '333333', group_id: 'patrick', staff_notes: 'VIP' }, boss.token);
  const d = await call('/members', 'POST', { nickname: 'Pat', phone: '09175551234' }, boss.token);
  assert.equal(d.body.code, 'possible_duplicate'); assert.deepEqual(d.body.matches[0].why, ['phone']);
  await call('/members', 'POST', { nickname: 'Pat', email: 'pat@x.com', member_no: '100000', group_id: 'patrick', confirm_duplicate: true, staff_notes: 'Came Friday' }, boss.token);
  const pt = structuredClone((await call('/ppm', 'GET', null, boss.token)).body);
  pt.tables[3].sessions = [{ seatId: 1, memberId: '100000', startTime: '2026-10-29 20:00:00', endTime: '2026-10-29 21:00:00', activeSeconds: 3600, restSeconds: 0, buyInAmount: 1000 }];
  assert.equal((await call('/ppm', 'PUT', { version: pt.version, tables: pt.tables }, boss.token)).status, 200);
  await call('/members/100000/rewards', 'POST', { type: 'free_chip', amount: 500, staff: 'Boss' }, boss.token);
  assert.equal((await call('/members/100000/merge', 'POST', { into: '333333' }, maria.token)).status, 403, 'master only');
  const mg = await call('/members/100000/merge', 'POST', { into: '333333', staff: 'Boss' }, boss.token);
  assert.equal(mg.status, 200, JSON.stringify(mg.body));
  const kept = (await call('/members/333333', 'GET', null, boss.token)).body;
  assert.equal(kept.stats.all.secs, 3600, 'game time moved'); assert.equal(kept.member.email, 'pat@x.com', 'blank fields filled');
  assert.match(kept.member.staff_notes, /VIP[\s\S]*Came Friday/);
  assert.equal((await call('/members/100000', 'GET', null, boss.token)).body.moved_to, 'EV-333333', 'old number points to the kept member');
  // Delete: needs confirmation when there are records; records go back to Unmatched.
  assert.equal((await call('/members/333333/delete', 'POST', {}, maria.token)).status, 403);
  const del = await call('/members/333333/delete', 'POST', { staff: 'Boss' }, boss.token);
  assert.equal(del.body.code, 'has_records'); assert.equal(del.body.sessions, 1);
  assert.equal((await call('/members/333333/delete', 'POST', { staff: 'Boss', confirm: true }, boss.token)).status, 200);
  assert.equal((await call('/members/333333', 'GET', null, boss.token)).status, 404);
  assert.equal((await call('/members/100000', 'GET', null, boss.token)).status, 404, 'alias removed too');
  const empty = (await call('/members', 'POST', { nickname: 'Oops' }, boss.token)).body.member_no;
  assert.equal((await call('/members/' + empty + '/delete', 'POST', { staff: 'Boss' }, boss.token)).status, 200, 'no records: deleted at once');
}
{ // Master deletes a game session; the next PPM save does not bring it back.
  await call('/members', 'POST', { nickname: 'Oops Table', member_no: '777777' }, boss.token);
  let cur = (await call('/ppm', 'GET', null, boss.token)).body;
  cur.tables[2].sessions = [...cur.tables[2].sessions, { seatId: 1, memberId: '777777', startTime: '2026-10-28 01:14:00', endTime: '2026-10-28 01:14:30', activeSeconds: 30, restSeconds: 0, buyInAmount: 12000 }];
  assert.equal((await call('/ppm', 'PUT', { version: cur.version, tables: cur.tables }, boss.token)).status, 200);
  const vs = (await call('/members/777777', 'GET', null, boss.token)).body.sessions;   const victim = vs.find((x) => x.buy_in === 12000);
  assert.equal(victim.buy_in, 12000);
  assert.equal((await call('/sessions/' + victim.id + '/delete', 'POST', {}, maria.token)).status, 403);
  assert.equal((await call('/sessions/' + victim.id + '/delete', 'POST', {}, boss.token)).status, 200);
  cur = (await call('/ppm', 'GET', null, boss.token)).body;
  assert.equal((await call('/ppm', 'PUT', { version: cur.version, tables: cur.tables }, boss.token)).status, 200);
  const left = (await call('/members/777777', 'GET', null, boss.token)).body.sessions;
  assert.equal(left.length, vs.length - 1, 'deleted session stays deleted'); assert.ok(!left.some((x) => x.buy_in === 12000));
}
{ // Master edits a session's times, buy-in and cash-out.
  const x = (await call('/members/777777', 'GET', null, boss.token)).body.sessions[0];
  const body = { start_at: x.start_at, end_at: x.start_at + 7200, active_seconds: 6000, rest_seconds: 600, buy_in: 45000, cash_out: 14800 };
  assert.equal((await call('/sessions/' + x.id + '/edit', 'POST', body, maria.token)).status, 403);
  assert.equal((await call('/sessions/' + x.id + '/edit', 'POST', { ...body, active_seconds: 9000 }, boss.token)).status, 400, 'play time cannot exceed the session');
  assert.equal((await call('/sessions/' + x.id + '/edit', 'POST', body, boss.token)).status, 200);
  const y = (await call('/members/777777', 'GET', null, boss.token)).body.sessions.find((s) => s.id === x.id);
  assert.deepEqual([y.buy_in, y.cash_out, y.active_seconds, y.rest_seconds, y.end_at - y.start_at], [45000, 14800, 6000, 600, 7200]);
  assert.equal((await call('/sessions/' + x.id + '/edit', 'POST', { ...body, cash_out: '', busted: false }, boss.token)).status, 200);
  assert.equal((await call('/members/777777', 'GET', null, boss.token)).body.sessions.find((s) => s.id === x.id).cash_out, null, 'blank clears the cash-out');
}
{ // Members sorted by last play; master moves one session to another member.
  const list = (await call('/members?sort=last&limit=200', 'GET', null, boss.token)).body.members;
  const lp = list.map((m) => m.last_play).filter((x) => x != null);
  assert.ok(lp.length > 1 && lp.every((x, i) => i === 0 || lp[i - 1] >= x), 'most recent first');
  assert.equal(list[list.length - 1].last_play, null, 'never played at the end');
  const x = (await call('/members/777777', 'GET', null, boss.token)).body.sessions[0];
  assert.equal((await call('/sessions/' + x.id + '/move', 'POST', { member_no: '444444' }, maria.token)).status, 403);
  const mv = await call('/sessions/' + x.id + '/move', 'POST', { member_no: '444444', confirm: true }, boss.token);
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  assert.ok((await call('/members/444444', 'GET', null, boss.token)).body.sessions.some((s) => s.id === x.id));
}
{ // Master recovers a session that never reached the member system, from the CSV PPM exported.
  await call('/members', 'POST', { nickname: 'JOY', member_no: '666666', confirm_duplicate: true }, boss.token);
  const rows = [{ table: 'T1', seat: '7', member: 'JOY (666666)', start: '2026-11-03 03:06:19', end: '2026-11-03 05:57:15', active: '10224', rest: '31', buy_in: '10000', cash_out: '' }];
  assert.equal((await call('/sessions/import-ppm', 'POST', { rows, dry_run: true }, maria.token)).status, 403);
  const dry = (await call('/sessions/import-ppm', 'POST', { rows, dry_run: true, blinds: '50 / 100' }, boss.token)).body.rows[0];
  assert.equal(dry.status, 'missing'); assert.equal(dry.will_go_to, 'EV-666666');
  const imp = (await call('/sessions/import-ppm', 'POST', { rows, blinds: '50 / 100' }, boss.token)).body;
  assert.equal(imp.imported, 1); assert.equal(imp.rows[0].status, 'recorded'); assert.equal(imp.rows[0].member_no, 'EV-666666');
  const joy = (await call('/members/666666', 'GET', null, boss.token)).body.sessions[0];
  assert.deepEqual([joy.table_name, joy.seat, joy.active_seconds, joy.buy_in, joy.blinds], ['T1', 7, 10224, 10000, '50 / 100']);
  assert.equal((await call('/sessions/import-ppm', 'POST', { rows }, boss.token)).body.imported, 0, 'importing twice adds nothing');
}
{ // A PPM save reports where each finished session went; the 5-minute check records anything a save missed.
  let cur = (await call('/ppm', 'GET', null, boss.token)).body;
  cur.tables[1].sessions = [...cur.tables[1].sessions, { seatId: 4, memberId: 'JOY (666666)', startTime: '2026-11-03 06:00:00', endTime: '2026-11-03 07:00:00', activeSeconds: 3500, restSeconds: 0, buyInAmount: 8000, cashOutAmount: 9000 }];
  const saved = await call('/ppm', 'PUT', { version: cur.version, tables: cur.tables }, boss.token);
  assert.equal(saved.status, 200); assert.equal(saved.body.sync.inserted, 1);
  assert.deepEqual(saved.body.sync.sessions[0], { ref: 'JOY (666666)', table: cur.tables[1].name, seat: 4, member_no: 'EV-666666' });
  // Simulate a session that reached PPM but was never copied (e.g. the copy failed), then the scheduled check.
  const row = JSON.parse(sql.prepare('SELECT data FROM ppm WHERE id=1').get().data);
  row[1].sessions.push({ seatId: 5, memberId: 'JOY (666666)', startTime: '2026-11-03 07:10:00', endTime: '2026-11-03 07:20:00', activeSeconds: 600, restSeconds: 0, buyInAmount: 1000 });
  sql.prepare('UPDATE ppm SET data=? WHERE id=1').run(JSON.stringify(row));
  let waits = []; await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) }); await Promise.all(waits);
  assert.ok((await call('/members/666666', 'GET', null, boss.token)).body.sessions.some((x) => x.start_at && x.seat === 5), 'scheduled check recorded it');
}
console.log('PASS members: auth, groups, create, import, PPM play time by number and nickname, no duplicates, group change keeps past hours, rewards by group at time, void, summary, unmatched link, audit, 21+ registration, search, staff accounts, staff/manager roles with reward approval, photos, staff account management, master/manager/staff, member number change, six-digit numbers, link players still at the table, nationality, link guards and undo, cash-out and W/L, group members and corrections, nickname + nationality, smallest free number, remark on create, duplicate guard, merge, delete, delete session, edit session, sort by last play, move session, recover from PPM CSV, sync report + scheduled check');
