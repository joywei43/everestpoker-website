// Everest member app API (phase 2). Members sign in with member number + birthday.
// Members only ever see their own name, play time and waitlist place — never buy-ins, groups, rewards or staff notes.
import { str, localDate } from './members.mjs';

const DAY = 86400;
const SESSION_DAYS = 30;
const enc = new TextEncoder();
const sha256 = async (v) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(v)))).map((x) => x.toString(16).padStart(2, '0')).join('');
const all = async (stmt) => (await stmt.all()).results || [];
const bad = (reply, msg, status = 400) => reply({ error: msg }, status);
async function readJson(req, max = 5000) {
  const text = await req.text();
  if (text.length > max) { const e = new Error('Too large'); e.status = 413; throw e; }
  return text ? JSON.parse(text) : {};
}
const shortName = (m) => m.nickname || m.surname || m.family_name || m.member_no;

async function memberFromToken(req, env, now) {
  const h = req.headers.get('Authorization') || '';
  if (!/^Bearer [a-f0-9]{64}$/.test(h)) return null;
  const row = await env.DB.prepare('SELECT ms.expires, m.* FROM member_sessions ms JOIN members m ON m.id=ms.member_id WHERE ms.token=?').bind(await sha256(h.slice(7))).first();
  if (!row || row.expires <= now || row.status !== 'active') return null;
  return row;
}

// Public view of the room built from the live PPM/waiting-list state. No player names.
async function roomSummary(env, now) {
  const row = await env.DB.prepare('SELECT data FROM room WHERE id=1').first();
  const s = row ? JSON.parse(row.data) : { queue: [], occupied: [], games: [], tableTypes: [], calls: {} };
  const names = ['T1', 'T2', 'T3', 'T5'];
  const count = Number(s.count) || 4;
  const tables = [];
  for (let i = 0; i < Math.min(count, (s.occupied || []).length); i++) {
    if (Array.isArray(s.tableOpen) && !s.tableOpen[i]) continue; // closed tables are hidden, same as the public page
    const seats = (s.occupied[i] || []).map((v) => (v ? 1 : 0));
    const game = `${(s.games || [])[i] || ''} ${(s.tableTypes || [])[i] || ''}`.trim();
    tables.push({ name: names[i] || 'T' + (i + 1), game_type: (s.tableTypes || [])[i] || '', blinds: (s.games || [])[i] || '', game, seats, taken: seats.reduce((a, b) => a + b, 0) });
  }
  const waiting = {};
  for (const p of s.queue || []) waiting[p.game] = (waiting[p.game] || 0) + 1;
  const today = localDate(now);
  const promos = await all(env.DB.prepare("SELECT id,title,body,starts,ends FROM promotions WHERE active=1 AND (starts='' OR starts<=?) AND (ends='' OR ends>=?) ORDER BY sort, id").bind(today, today));
  return { tables, waiting, games: Object.keys(s.counters || {}), promotions: promos, updated_at: now };
}

function myQueue(state, memberNo) {
  const out = [];
  for (const p of state.queue || []) {
    if (p.member_no !== memberNo) continue;
    const ahead = (state.queue || []).filter((q) => q.game === p.game && q.num < p.num).length;
    out.push({ game: p.game, num: p.num, position: ahead + 1 });
  }
  for (const [game, p] of Object.entries(state.calls || {})) {
    if (p && p.member_no === memberNo) out.push({ game, num: p.num, position: 0, called: true });
  }
  return out;
}

// Read-modify-write of the shared room state with the same version check staff screens use.
async function updateRoom(env, change) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await env.DB.prepare('SELECT version,data FROM room WHERE id=1').first();
    const state = JSON.parse(row.data);
    const result = change(state);
    if (result && result.error) return result;
    const saved = await env.DB.prepare('UPDATE room SET version=version+1,data=? WHERE id=1 AND version=? RETURNING version').bind(JSON.stringify(state), row.version).first();
    if (saved) return { ok: true, state };
  }
  return { error: 'The waiting list is busy. Please try again.' };
}

export async function handleMemberApp(req, env, path, now, reply, ipHash) {
  const method = req.method;

  if (path === '/member/room' && method === 'GET') return reply(await roomSummary(env, now));

  if (path === '/member/login' && method === 'POST') {
    const attempt = await env.DB.prepare('INSERT INTO member_login_attempts(ip,started,count) VALUES(?,?,1) ON CONFLICT(ip) DO UPDATE SET count=CASE WHEN started<? THEN 1 ELSE count+1 END,started=CASE WHEN started<? THEN ? ELSE started END RETURNING count')
      .bind(ipHash, now, now - 900, now - 900, now).first();
    if (attempt.count > 10) return bad(reply, 'too_many', 429);
    const b = await readJson(req);
    const no = str(b.member_no, 30), birthday = str(b.birthday, 10);
    const m = no ? await env.DB.prepare('SELECT id,member_no,birthday,status FROM members WHERE member_no=? COLLATE NOCASE').bind(no).first() : null;
    if (!m || !m.birthday || m.birthday !== birthday) return bad(reply, 'wrong', 401);
    if (m.status !== 'active') return bad(reply, 'inactive', 403);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((x) => x.toString(16).padStart(2, '0')).join('');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM member_sessions WHERE expires<?').bind(now),
      env.DB.prepare('DELETE FROM member_login_attempts WHERE started<?').bind(now - 900),
      env.DB.prepare('INSERT INTO member_sessions(token,member_id,expires) VALUES(?,?,?)').bind(await sha256(token), m.id, now + SESSION_DAYS * DAY)
    ]);
    return reply({ token, expires: now + SESSION_DAYS * DAY });
  }

  const m = await memberFromToken(req, env, now);
  if (!m) return bad(reply, 'login', 401);

  if (path === '/member/logout' && method === 'POST') {
    const h = req.headers.get('Authorization');
    await env.DB.prepare('DELETE FROM member_sessions WHERE token=?').bind(await sha256(h.slice(7))).run();
    return reply({ ok: true });
  }

  if (path === '/member/me' && method === 'GET') {
    const since = now - 30 * DAY;
    const stat = (t) => env.DB.prepare('SELECT COUNT(*) sessions, COUNT(DISTINCT play_date) days, COALESCE(SUM(active_seconds),0) secs FROM play_sessions WHERE member_id=? AND start_at>=?').bind(m.id, t).first();
    const [s30, sAll] = await Promise.all([stat(since), stat(0)]);
    const sessions = await all(env.DB.prepare('SELECT play_date,game_type,blinds,active_seconds FROM play_sessions WHERE member_id=? ORDER BY start_at DESC LIMIT 30').bind(m.id));
    const room = await env.DB.prepare('SELECT data FROM room WHERE id=1').first();
    return reply({
      member: { member_no: m.member_no, name: [m.surname, m.middle_name, m.family_name].filter(Boolean).join(' ') || shortName(m), nickname: m.nickname, language: m.language },
      stats: { last30: s30, all: sAll },
      sessions,
      waitlist: room ? myQueue(JSON.parse(room.data), m.member_no) : []
    });
  }

  if (path === '/member/waitlist' && method === 'POST') {
    const b = await readJson(req);
    const game = str(b.game, 30);
    const res = await updateRoom(env, (s) => {
      if (!s.counters || !s.counters[game]) return { error: 'unknown_game' };
      if ((s.queue || []).some((p) => p.member_no === m.member_no) || Object.values(s.calls || {}).some((p) => p && p.member_no === m.member_no)) return { error: 'already_waiting' };
      if ((s.queue || []).length >= 500) return { error: 'full' };
      s.queue.push({ num: s.counters[game]++, name: shortName(m).slice(0, 60), game, member_no: m.member_no });
      return null;
    });
    if (res.error) return bad(reply, res.error, res.error === 'already_waiting' ? 409 : 400);
    return reply({ ok: true, waitlist: myQueue(res.state, m.member_no) });
  }

  if (path === '/member/waitlist/leave' && method === 'POST') {
    const res = await updateRoom(env, (s) => {
      s.queue = (s.queue || []).filter((p) => p.member_no !== m.member_no);
      return null;
    });
    if (res.error) return bad(reply, res.error);
    return reply({ ok: true, waitlist: myQueue(res.state, m.member_no) });
  }

  return bad(reply, 'Not found', 404);
}

// ----- Promotions editor (staff API, managers edit) -----
export async function handlePromotions(req, env, path, now, reply, manager) {
  const parts = path.split('/').filter(Boolean);
  const clean = (b) => ({ title: str(b.title, 120), body: str(b.body, 1000), starts: /^\d{4}-\d{2}-\d{2}$/.test(b.starts || '') ? b.starts : '', ends: /^\d{4}-\d{2}-\d{2}$/.test(b.ends || '') ? b.ends : '', active: b.active === false || b.active === 0 ? 0 : 1, sort: Number.isSafeInteger(Number(b.sort)) ? Number(b.sort) : 0 });
  if (parts.length === 1 && req.method === 'GET') return reply({ promotions: await all(env.DB.prepare('SELECT * FROM promotions ORDER BY active DESC, sort, id')) });
  if (!manager) return bad(reply, 'Manager only.', 403);
  if (parts.length === 1 && req.method === 'POST') {
    const p = clean(await readJson(req));
    if (!p.title) return bad(reply, 'Title is required.');
    await env.DB.prepare('INSERT INTO promotions(title,body,starts,ends,active,sort,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind(p.title, p.body, p.starts, p.ends, p.active, p.sort, now, now).run();
    return reply({ ok: true });
  }
  if (parts.length === 2 && req.method === 'PUT') {
    const p = clean(await readJson(req));
    if (!p.title) return bad(reply, 'Title is required.');
    await env.DB.prepare('UPDATE promotions SET title=?,body=?,starts=?,ends=?,active=?,sort=?,updated_at=? WHERE id=?').bind(p.title, p.body, p.starts, p.ends, p.active, p.sort, now, Number(parts[1])).run();
    return reply({ ok: true });
  }
  return null;
}
