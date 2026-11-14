// Cage (finance) store: the cage page keeps its records as small JSON documents grouped in collections.
// GET  /cage?since=<rev>  → documents changed after that rev (deleted ones come back with deleted:true)
// POST /cage/doc          → {coll, id, op:'set'|'update'|'delete', data?, ifVersion?}
import { auditStmt } from './audit.mjs';
import { handleOperation } from './operation.mjs';

const COLLS = ['entries', 'players', 'midori', 'ppm', 'manpower', 'counts', 'config', 'photos'];
const MANAGER_ONLY = ['config', 'manpower']; // starting balances, rates and staff costs
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX = { photos: 400000 };
const isManager = (role) => role === 'admin' || role === 'master';

export async function handleCage(req, env, path, now, reply, user, role) {
  if (path === '/cage' && req.method === 'GET') {
    const since = Math.max(0, Math.floor(Number(new URL(req.url).searchParams.get('since')) || 0));
    const rows = (await env.DB.prepare("SELECT coll,id,data,deleted,version,rev FROM cage_docs WHERE rev>? AND coll<>'photos' ORDER BY rev LIMIT 2000").bind(since).all()).results || [];
    const meta = await env.DB.prepare('SELECT rev FROM cage_meta WHERE id=1').first();
    return reply({
      rev: meta ? meta.rev : 0,
      more: rows.length === 2000,
      docs: rows.map((r) => ({ coll: r.coll, id: r.id, version: r.version, rev: r.rev, deleted: !!r.deleted, data: r.deleted ? null : JSON.parse(r.data) })),
      user, role,
    });
  }
  // PPM buy-in and cash-out per player for a business day, for the cage's comparison (names and numbers only).
  if (path === '/cage/ppm' && req.method === 'GET') {
    const day = new URL(req.url).searchParams.get('day') || '';
    const u = new URL('https://x/operation'); if (/^\d{4}-\d{2}-\d{2}$/.test(day)) u.searchParams.set('day', day);
    const op = await handleOperation(new Request(u), env, now, (o) => o, 'admin');
    if (!op || op.error) return reply({ error: (op && op.error) || 'PPM not available' }, 500);
    return reply({ day: op.day, rows: (op.visitor_list || []).map((v) => ({ no: v.member_no || null, name: v.member_no ? (v.nickname || v.name) : v.name, buy_in: v.buy_in || 0, cash_out: v.cash_out || 0, playing: !!v.playing_now, open: v.missing_cash_out || 0 })) });
  }
  // Insurance tickets from the insurance page, per business day, so the cage counts insurance chips without typing them again.
  // Settled only: miss = house keeps the premium (+), hit = house paid the payout (−). Pending tickets are listed, not counted.
  if (path === '/cage/insurance' && req.method === 'GET') {
    const q = new URL(req.url).searchParams, ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    const from = q.get('from'), to = q.get('to');
    if (!ok(from) || !ok(to) || from > to) return reply({ error: 'Give from and to days.' }, 400);
    const rows = (await env.DB.prepare("SELECT id,day,created_at,table_name,pot,amount,payout,result FROM insurance_tickets WHERE day>=? AND day<=? AND result<>'void' ORDER BY id LIMIT 5000").bind(from, to).all()).results || [];
    const days = {};
    for (const r of rows) {
      const d = days[r.day] = days[r.day] || { net: 0, sold: 0, paid: 0, kept: 0, hits: 0, misses: 0, pending: 0, pending_amount: 0, tickets: 0 };
      d.tickets++; d.sold += r.amount;
      if (r.result === 'miss') { d.misses++; d.kept += r.amount; d.net += r.amount; }
      else if (r.result === 'hit') { d.hits++; d.paid += r.payout; d.net -= r.payout; }
      else { d.pending++; d.pending_amount += r.amount; }
    }
    return reply({ from, to, days, tickets: rows.filter((r) => r.day === to) });
  }
  if (path.startsWith('/cage/photo/') && req.method === 'GET') {
    const id = path.slice('/cage/photo/'.length);
    if (!ID.test(id)) return reply({ error: 'Bad id' }, 400);
    const r = await env.DB.prepare("SELECT data FROM cage_docs WHERE coll='photos' AND id=? AND deleted=0").bind(id).first();
    return r ? reply(JSON.parse(r.data)) : reply({ error: 'Not found' }, 404);
  }
  if (path === '/cage/doc' && req.method === 'POST') {
    const raw = await req.text();
    if (raw.length > 450000) return reply({ error: 'Too large' }, 413);
    const b = JSON.parse(raw);
    const { coll, id, op } = b || {};
    if (!COLLS.includes(coll) || typeof id !== 'string' || !ID.test(id) || !['set', 'update', 'delete'].includes(op)) return reply({ error: 'Invalid request' }, 400);
    if (MANAGER_ONLY.includes(coll) && !isManager(role)) return reply({ error: 'Only a manager can change this.' }, 403);
    if (op === 'delete' && !isManager(role)) return reply({ error: 'Only a manager can delete.' }, 403);
    if (op !== 'delete' && (!b.data || typeof b.data !== 'object' || Array.isArray(b.data))) return reply({ error: 'Invalid data' }, 400);
    const cur = await env.DB.prepare('SELECT data,deleted,version FROM cage_docs WHERE coll=? AND id=?').bind(coll, id).first();
    if (b.ifVersion != null && (!cur || cur.version !== b.ifVersion)) return reply({ error: 'Someone else changed this. Reload and try again.' }, 409);
    if (op === 'update' && (!cur || cur.deleted)) return reply({ error: 'Not found' }, 404);
    let data = null;
    if (op === 'set') data = b.data;
    if (op === 'update') data = { ...JSON.parse(cur.data), ...b.data };
    const text = data ? JSON.stringify(data) : null;
    if (text && text.length > (MAX[coll] || 120000)) return reply({ error: 'Too large' }, 413);
    const version = cur ? cur.version + 1 : 1;
    const stmts = [
      env.DB.prepare('UPDATE cage_meta SET rev=rev+1 WHERE id=1'),
      env.DB.prepare('INSERT INTO cage_docs(coll,id,data,deleted,version,rev,updated,updated_by) VALUES(?,?,?,?,?,(SELECT rev FROM cage_meta WHERE id=1),?,?) ' +
        'ON CONFLICT(coll,id) DO UPDATE SET data=excluded.data,deleted=excluded.deleted,version=excluded.version,rev=excluded.rev,updated=excluded.updated,updated_by=excluded.updated_by WHERE cage_docs.version=?')
        .bind(coll, id, text || 'null', op === 'delete' ? 1 : 0, version, now, String(user || ''), cur ? cur.version : 0),
    ];
    if (MANAGER_ONLY.includes(coll) || op === 'delete' || coll === 'counts') {
      const what = coll === 'counts' && data ? `${data.kind || ''} count ${data.day || ''}`.trim() : `${coll}/${id}`;
      stmts.push(auditStmt(env, now, user || 'staff', 'cage.' + (op === 'delete' ? 'delete' : coll === 'counts' ? 'count' : 'settings'), what));
    }
    const res = await env.DB.batch(stmts);
    if (!res[1].meta.changes) return reply({ error: 'Someone else changed this. Reload and try again.' }, 409);
    const meta = await env.DB.prepare('SELECT rev FROM cage_meta WHERE id=1').first();
    return reply({ ok: true, version, rev: meta.rev });
  }
  return null;
}
