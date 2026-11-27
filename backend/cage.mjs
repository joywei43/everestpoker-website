// Cage (finance) store: the cage page keeps its records as small JSON documents grouped in collections.
// GET  /cage?since=<rev>  → documents changed after that rev (deleted ones come back with deleted:true)
// POST /cage/doc          → {coll, id, op:'set'|'update'|'delete', data?, ifVersion?}
import { auditStmt } from './audit.mjs';
import { handleOperation } from './operation.mjs';
import { managerApproval } from './cardauth.mjs';
import { str, normNo, displayName } from './members.mjs';

const COLLS = ['entries', 'players', 'midori', 'ppm', 'manpower', 'counts', 'config', 'photos', 'corrections', 'shifts'];
const SETTINGS = ['config', 'manpower']; // starting balances, rates and staff costs: changes go to the History Log
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX = { photos: 400000 };


// ----- Member cards: a card's own number (UID) points to one member. The card stores nothing else. -----
const cardUid = (v) => { const u = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return u.length >= 4 && u.length <= 32 ? u : ''; };
async function cardMember(env, memberId) {
  const m = await env.DB.prepare('SELECT m.*, g.name group_name, EXISTS(SELECT 1 FROM member_photos p WHERE p.member_id=m.id) has_photo FROM members m LEFT JOIN member_groups g ON g.id=m.group_id WHERE m.id=?').bind(memberId).first();
  return m && { member_no: m.member_no, name: displayName(m), nickname: m.nickname || '', nationality: m.nationality || '', group_name: m.group_name || null, has_photo: !!m.has_photo, status: m.status };
}
async function handleCards(req, env, path, now, reply, user, role) {
  const manager = role === 'admin' || role === 'master';
  if (path.startsWith('/cage/card/') && req.method === 'GET') {
    const uid = cardUid(decodeURIComponent(path.slice('/cage/card/'.length)));
    if (!uid) return reply({ error: 'Not a card number.' }, 400);
    const c = await env.DB.prepare('SELECT * FROM member_cards WHERE uid=?').bind(uid).first();
    if (!c) return reply({ uid, unknown: true });
    const member = await cardMember(env, c.member_id);
    if (!c.active) return reply({ uid, inactive: true, replaced_at: c.replaced_at, member });
    return reply({ uid, card: { uid, linked_at: c.linked_at, linked_by: c.linked_by }, member });
  }
  if (path === '/cage/cards' && req.method === 'GET') {
    const no = normNo(new URL(req.url).searchParams.get('member_no') || '');
    const m = no && await env.DB.prepare('SELECT id FROM members WHERE member_no=? COLLATE NOCASE').bind(no).first();
    if (!m) return reply({ error: 'Member not found.' }, 404);
    const rows = (await env.DB.prepare('SELECT uid,active,linked_at,linked_by,approved_by,replaced_at,replaced_by FROM member_cards WHERE member_id=? ORDER BY linked_at DESC').bind(m.id).all()).results || [];
    return reply({ cards: rows.map((r) => ({ ...r, active: !!r.active })) });
  }
  if ((path === '/cage/card/link' || path === '/cage/card/off') && req.method === 'POST') {
    if (role === 'senior') return reply({ error: 'Read only.' }, 403);
    const b = await req.json().catch(() => ({}));
    const uid = cardUid(b.uid);
    if (!uid) return reply({ error: 'Tap the card first.' }, 400);
    // Cards are given and replaced with a manager's approval: signed in as a manager, or a manager types their Admin username + password.
    let approver = manager ? String(user || '') : null;
    if (!approver) { const a = await managerApproval(env, b.approver_user, b.approver_password, now); if (a.error) return reply({ error: a.error }, a.status); approver = a.name; }
    const cur = await env.DB.prepare('SELECT * FROM member_cards WHERE uid=?').bind(uid).first();
    if (path === '/cage/card/off') {
      if (!cur || !cur.active) return reply({ error: 'This card is not in use.' }, 404);
      await env.DB.batch([
        env.DB.prepare('UPDATE member_cards SET active=0,replaced_at=?,replaced_by=? WHERE uid=?').bind(now, approver, uid),
        auditStmt(env, now, user || 'staff', 'member.card', `Card ${uid} turned off (lost / broken) · approved by ${approver}`, cur.member_id),
      ]);
      return reply({ ok: true });
    }
    const no = normNo(b.member_no || '');
    const m = no && await env.DB.prepare('SELECT id,member_no FROM members WHERE member_no=? COLLATE NOCASE').bind(no).first();
    if (!m) return reply({ error: 'Member not found.' }, 404);
    if (cur && cur.active && cur.member_id !== m.id) {
      const other = await cardMember(env, cur.member_id);
      return reply({ error: `This card already belongs to ${other ? other.name + ' #' + other.member_no : 'another member'}.`, owner: other }, 409);
    }
    if (cur && cur.active && cur.member_id === m.id) return reply({ ok: true, unchanged: true });
    const old = (await env.DB.prepare('SELECT uid FROM member_cards WHERE member_id=? AND active=1 AND uid<>?').bind(m.id, uid).all()).results || [];
    await env.DB.batch([
      env.DB.prepare('UPDATE member_cards SET active=0,replaced_at=?,replaced_by=? WHERE member_id=? AND active=1 AND uid<>?').bind(now, approver, m.id, uid),
      env.DB.prepare('INSERT INTO member_cards(uid,member_id,active,linked_at,linked_by,approved_by,replaced_at,replaced_by) VALUES(?,?,1,?,?,?,NULL,NULL) ON CONFLICT(uid) DO UPDATE SET member_id=excluded.member_id,active=1,linked_at=excluded.linked_at,linked_by=excluded.linked_by,approved_by=excluded.approved_by,replaced_at=NULL,replaced_by=NULL')
        .bind(uid, m.id, now, str(user || 'staff', 60), approver),
      auditStmt(env, now, user || 'staff', 'member.card', `Card ${uid} linked${old.length ? ' (replaces ' + old.map((o) => o.uid).join(', ') + ')' : ''} · approved by ${approver}`, m.id),
    ]);
    return reply({ ok: true, member: await cardMember(env, m.id), replaced: old.map((o) => o.uid) });
  }
  return null;
}

export async function handleCage(req, env, path, now, reply, user, role) {
  if (path === '/cage/cards' || path.startsWith('/cage/card/')) { const r = await handleCards(req, env, path, now, reply, user, role); if (r) return r; }
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
  // Staff schedule for the admin console: the tip roster (from cage settings) and the days off saved per business day.
  if (path === '/cage/schedule' && req.method === 'GET') {
    const q = new URL(req.url).searchParams, ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    const from = q.get('from'), to = q.get('to');
    if (!ok(from) || !ok(to) || from > to) return reply({ error: 'Give from and to days.' }, 400);
    const st = await env.DB.prepare("SELECT data FROM cage_docs WHERE coll='config' AND id='settings' AND deleted=0").first();
    const set = st ? JSON.parse(st.data) : {};
    const rows = (await env.DB.prepare("SELECT id,data FROM cage_docs WHERE coll='shifts' AND deleted=0 AND id>=? AND id<=? ORDER BY id").bind(from, to).all()).results || [];
    return reply({ tipStaff: set.tipStaff || null, days: rows.map((r) => ({ day: r.id, ...JSON.parse(r.data) })) });
  }
  if (path === '/cage/doc' && req.method === 'POST') {
    const raw = await req.text();
    if (raw.length > 450000) return reply({ error: 'Too large' }, 413);
    const b = JSON.parse(raw);
    const { coll, id, op } = b || {};
    if (!COLLS.includes(coll) || typeof id !== 'string' || !ID.test(id) || !['set', 'update', 'delete'].includes(op)) return reply({ error: 'Invalid request' }, 400);
    // Every signed-in staff account has full access to the cage (record, void, delete, settings); every change is logged.
    if (op !== 'delete' && (!b.data || typeof b.data !== 'object' || Array.isArray(b.data))) return reply({ error: 'Invalid data' }, 400);
    const cur = await env.DB.prepare('SELECT data,deleted,version FROM cage_docs WHERE coll=? AND id=?').bind(coll, id).first();
    if (b.ifVersion != null && (!cur || cur.version !== b.ifVersion)) return reply({ error: 'Someone else changed this. Reload and try again.' }, 409);
    if (op === 'update' && (!cur || cur.deleted)) return reply({ error: 'Not found' }, 404);
    let data = null;
    if (op === 'set') data = b.data;
    if (op === 'update') data = { ...JSON.parse(cur.data), ...b.data };
    // Entries keep who recorded them (set by the server, not the browser) and who voided them.
    if (coll === 'entries' && data) {
      const old = cur && !cur.deleted ? JSON.parse(cur.data) : null;
      data = { ...data, by: (old && old.by) || String(user || '') };
      if (data.voided && !(old && old.voided)) data.voidedBy = String(user || '');
      else if (old && old.voidedBy) data.voidedBy = old.voidedBy;
    }
    // Correction requests: anyone asks; a manager decides; a change of amount (or removing a record) needs the owner (master).
    if (coll === 'corrections') {
      const old = cur && !cur.deleted ? JSON.parse(cur.data) : null;
      if (op === 'delete') return reply({ error: 'Correction requests are kept.' }, 403);
      if (!old) { if (data.status !== 'pending') return reply({ error: 'A new request starts as pending.' }, 400); data = { ...data, requestedBy: String(user || '') }; }
      else {
        if (old.status !== 'pending') return reply({ error: 'This request was already decided.' }, 409);
        if (['approved', 'rejected'].includes(data.status)) {
          if (role === 'staff') return reply({ error: 'Only a manager can approve or reject a correction.' }, 403);
          if (data.status === 'approved' && old.money && role !== 'master') return reply({ error: 'This correction changes an amount: only the owner can approve it.' }, 403);
          data = { ...old, status: data.status, note: String(data.note || '').slice(0, 300), newEntry: data.newEntry || null, decidedBy: String(user || ''), decidedAt: new Date(now * 1000).toISOString() };
        } else data = { ...old };
      }
    }
    const text = data ? JSON.stringify(data) : null;
    if (text && text.length > (MAX[coll] || 120000)) return reply({ error: 'Too large' }, 413);
    const version = cur ? cur.version + 1 : 1;
    const stmts = [
      env.DB.prepare('UPDATE cage_meta SET rev=rev+1 WHERE id=1'),
      env.DB.prepare('INSERT INTO cage_docs(coll,id,data,deleted,version,rev,updated,updated_by) VALUES(?,?,?,?,?,(SELECT rev FROM cage_meta WHERE id=1),?,?) ' +
        'ON CONFLICT(coll,id) DO UPDATE SET data=excluded.data,deleted=excluded.deleted,version=excluded.version,rev=excluded.rev,updated=excluded.updated,updated_by=excluded.updated_by WHERE cage_docs.version=?')
        .bind(coll, id, text || 'null', op === 'delete' ? 1 : 0, version, now, String(user || ''), cur ? cur.version : 0),
    ];
    if (SETTINGS.includes(coll) || op === 'delete' || coll === 'counts') {
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
