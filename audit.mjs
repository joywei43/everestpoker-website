// History Log: who did what. Everything is written to audit_log; this module adds PPM actions and the read API.
import { str } from './members.mjs';

const all = async (stmt) => (await stmt.all()).results || [];
const n = (v) => Math.round(Number(v) || 0).toLocaleString('en-US');

export const auditStmt = (env, now, actor, action, detail, memberId = null) =>
  env.DB.prepare('INSERT INTO audit_log(at,actor,action,member_id,detail) VALUES(?,?,?,?,?)').bind(now, str(actor || '', 60), action, memberId, str(detail, 500));

// Compare two PPM saves and describe what staff did: tables opened/closed, level changes, seat in/out, chips, rest, seat moves.
export function ppmChanges(prev, next) {
  const out = [];
  const add = (action, detail) => out.push({ action, detail });
  const where = (t, s) => `${t.name || 'T' + t.id} #${s.id}`;
  const busy = (s) => s && s.status !== 'idle' && str(s.memberId, 60);
  const before = new Map(), after = new Map();
  for (const t of prev || []) for (const s of t.seats || []) if (busy(s)) before.set(str(s.memberId, 60).toLowerCase(), { t, s });
  for (const t of next || []) for (const s of t.seats || []) if (busy(s)) after.set(str(s.memberId, 60).toLowerCase(), { t, s });
  const prevById = new Map((prev || []).map((t) => [t.id, t]));
  const moved = new Set();

  for (const t of next || []) {
    const p = prevById.get(t.id);
    if (!p) continue;
    const name = t.name || 'T' + t.id;
    if (!p.isRunning && t.isRunning) add('ppm.table_open', `${p.openedAt && p.openedAt === t.openedAt ? 'Resumed' : 'Opened'} ${name} · ${t.gameType} ${t.blinds}`);
    if (p.isRunning && !t.isRunning) add('ppm.table_close', `${t.closedAt && t.closedAt !== p.closedAt ? 'Closed' : 'Paused'} ${name}`);
    if (p.gameType !== t.gameType || p.blinds !== t.blinds) add('ppm.level', `${name} level ${p.gameType} ${p.blinds} → ${t.gameType} ${t.blinds}`);
    if ((p.sessions || []).length > (t.sessions || []).length && !(t.sessions || []).length) add('ppm.reset', `Reset ${name} (${(p.sessions || []).length} session rows cleared after export)`);
  }

  // Seat moves: the same player at a different seat.
  for (const [key, a] of after) {
    const b = before.get(key);
    if (!b || (b.t.id === a.t.id && b.s.id === a.s.id)) continue;
    moved.add(key);
    if (b.t.id === a.t.id) add('ppm.change_seat', `${a.s.memberId}: ${where(b.t, b.s)} → ${where(a.t, a.s)}`);
    else add('ppm.change_table', `${a.s.memberId}: ${where(b.t, b.s)} → ${where(a.t, a.s)} with ${n(a.s.buyInAmount)} chips (cashed out ${n(a.s.buyInAmount)} at ${b.t.name || 'T' + b.t.id})`);
  }
  for (const t of next || []) {
    const p = prevById.get(t.id);
    if (!p) continue;
    const newRows = (t.sessions || []).slice((p.sessions || []).length);
    for (const s of t.seats || []) {
      const o = (p.seats || []).find((x) => x.id === s.id) || {};
      const was = busy(o), now = busy(s);
      const wasKey = was ? str(o.memberId, 60).toLowerCase() : '', nowKey = now ? str(s.memberId, 60).toLowerCase() : '';
      if (was && (!now || wasKey !== nowKey) && !moved.has(wasKey)) {
        const row = newRows.find((r) => r.seatId === s.id && r.memberId === o.memberId);
        const res = row && Number.isFinite(row.cashOutAmount)
          ? (row.busted ? ' · busted' : ` · cash-out ${n(row.cashOutAmount)} · W/L ${row.cashOutAmount - (row.buyInAmount || 0) >= 0 ? '+' : '−'}${n(Math.abs(row.cashOutAmount - (row.buyInAmount || 0)))}`) : '';
        add('ppm.leave', `${o.memberId} left ${where(t, s)} · buy-in ${n(o.buyInAmount)}${res}`);
      }
      if (now && (!was || wasKey !== nowKey) && !moved.has(nowKey)) add('ppm.seat', `${s.memberId} sat at ${where(t, s)} · buy-in ${n(s.buyInAmount)}`);
      if (was && now && wasKey === nowKey) {
        if ((s.buyInAmount || 0) > (o.buyInAmount || 0)) add('ppm.add_chips', `${s.memberId} at ${where(t, s)} added ${n(s.buyInAmount - o.buyInAmount)} · total ${n(s.buyInAmount)}`);
        if (o.status === 'seated' && s.status === 'rest') add('ppm.rest', `${s.memberId} at ${where(t, s)} on a break`);
        if (o.status === 'rest' && s.status === 'seated') add('ppm.back', `${s.memberId} at ${where(t, s)} back from a break`);
      }
    }
  }
  return out;
}

const CATEGORIES = {
  login: ['staff.login', 'staff.login_failed', 'staff.logout'],
  ppm: ['ppm.%'], tables: ['table.%'], members: ['member.%'], sessions: ['session.%', 'sessions.%'],
  rewards: ['reward.%'], report: ['report.%'], promotions: ['promotion.%'], staff: ['staff.create', 'staff.update', 'staff.delete']
};

export async function handleAudit(req, env, now, reply, role) {
  if (role !== 'master') return reply({ error: 'Only the master account can see the History Log.' }, 403);
  const url = new URL(req.url), q = url.searchParams;
  const where = [], args = [];
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get('from') || '') ? q.get('from') : null, to = /^\d{4}-\d{2}-\d{2}$/.test(q.get('to') || '') ? q.get('to') : null;
  if (from) { where.push('a.at>=?'); args.push(Date.parse(from + 'T00:00:00+08:00') / 1000); }
  if (to) { where.push('a.at<?'); args.push(Date.parse(to + 'T00:00:00+08:00') / 1000 + 86400); }
  if (q.get('actor')) { where.push('a.actor=?'); args.push(str(q.get('actor'), 60)); }
  const cat = CATEGORIES[q.get('category') || ''];
  if (cat) { where.push('(' + cat.map(() => 'a.action LIKE ?').join(' OR ') + ')'); args.push(...cat); }
  if (q.get('q')) { const like = '%' + str(q.get('q'), 60) + '%'; where.push('(a.detail LIKE ? OR m.member_no LIKE ? OR m.nickname LIKE ? OR a.actor LIKE ?)'); args.push(like, like, like, like); }
  const before = Number(q.get('before'));
  if (Number.isSafeInteger(before) && before > 0) { where.push('a.id<?'); args.push(before); }
  const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 100));
  const rows = await all(env.DB.prepare(`SELECT a.id,a.at,a.actor,a.action,a.detail,m.member_no,m.nickname FROM audit_log a LEFT JOIN members m ON m.id=a.member_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ?`).bind(...args, limit + 1));
  const actors = (await all(env.DB.prepare("SELECT DISTINCT actor FROM audit_log WHERE actor<>'' ORDER BY actor COLLATE NOCASE"))).map((r) => r.actor);
  return reply({ entries: rows.slice(0, limit), more: rows.length > limit, actors });
}
