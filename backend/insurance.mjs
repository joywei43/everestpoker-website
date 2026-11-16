// All-in insurance sold at the table by the supervisor: odds table, limits, tickets and the day's result.
// The house sells cover against the leader's opponents hitting an out on the next card.
// Miss: the buyer keeps the pot and the house takes the premium. Hit: the buyer lost the pot, so no premium is taken and the house pays premium × odds.
import { businessDay } from './operation.mjs';
import { str } from './members.mjs';

// Payout multiple by number of players in the pot and number of outs (1–15). More than 15 outs: not sold.
export const ODDS = {
  2: [30, 15, 10, 8, 6, 5, 4, 3.5, 3, 2.5, 2.2, 2, 1.8, 1.6, 1.4],
  3: [29, 14, 9, 7, 5.5, 4.5, 3.5, 3.2, 2.5, 2.3, 2, 1.8, 1.5, 1.4, 1.3],
  4: [28, 13, 9, 6.5, 5, 4, 3.2, 3, 2.5, 2, 1.8, 1.5, 1.3, 1.2, 1.1]
};
export const CAP_BB = 1000; // the most the house pays on one ticket: 1000 big blinds (50-100 → 100,000)
export const CHIP = 25; // smallest chip: amounts are rounded down to it
export const oddsFor = (players, outs) => (ODDS[players] && outs >= 1 && outs <= 15 ? ODDS[players][outs - 1] : null);
export const bigBlind = (blinds) => { const m = /\/\s*([\d,]+)/.exec(String(blinds || '')); return m ? Number(m[1].replace(/,/g, '')) : null; };
export const maxBuy = (pot, bb, odds) => Math.floor(Math.min(pot, CAP_BB * bb) / odds / CHIP) * CHIP;
const POTS = ['Main', '1st Side', '2nd Side'];
const all = async (stmt) => (await stmt.all()).results || [];
const int = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isSafeInteger(n) ? n : NaN; };
const audit = (env, now, who, action, detail) => env.DB.prepare('INSERT INTO audit_log(at,actor,action,member_id,detail) VALUES(?,?,?,NULL,?)').bind(now, str(who || 'staff', 60), action, str(detail, 500));
const n = (v) => Math.round(v).toLocaleString('en-US');
const RESULTS = ['pending', 'miss', 'hit', 'void'];
const RNAME = { pending: 'pending', miss: 'kept (missed)', hit: 'paid out (hit)', void: 'void' };
const fixCorr = (c) => { try { c.before = JSON.parse(c.before); c.after = JSON.parse(c.after); } catch {} return c; };
const corrText = (b, a) => ['result', 'amount', 'payout'].filter((k) => a[k] !== b[k]).map((k) => k === 'result' ? `result ${RNAME[b[k]]} → ${RNAME[a[k]]}` : `${k === 'amount' ? 'bought' : 'payout'} ${n(b[k])} → ${n(a[k])}`).join(', ');

function totals(rows) {
  const live = rows.filter((r) => r.result !== 'void');
  const sold = live.reduce((s, r) => s + r.amount, 0);
  const paid = live.filter((r) => r.result === 'hit').reduce((s, r) => s + r.payout, 0);
  const settled = live.filter((r) => r.result === 'hit' || r.result === 'miss');
  return {
    tickets: live.length, sold, paid, hits: live.filter((r) => r.result === 'hit').length, misses: live.filter((r) => r.result === 'miss').length,
    pending: live.filter((r) => r.result === 'pending').length,
    pending_amount: live.filter((r) => r.result === 'pending').reduce((s, r) => s + r.amount, 0),
    net: settled.reduce((s, r) => s + (r.result === 'hit' ? -r.payout : r.amount), 0)
  };
}

export async function handleInsurance(req, env, path, now, reply, user, role) {
  const method = req.method, who = user || 'staff';
  if (path === '/insurance/config' && method === 'GET') {
    let tables = [];
    try {
      const row = await env.DB.prepare('SELECT data FROM ppm WHERE id=1').first();
      tables = (row ? JSON.parse(row.data) : []).map((t) => ({ name: t.name || 'T' + t.id, blinds: t.blinds, game: t.gameType, running: t.isRunning === true,
        seats: (t.seats || []).filter((x) => x.status !== 'idle' && x.memberId).map((x) => ({ seat: x.id, name: str(x.memberId, 60) })) }));
    } catch {}
    return reply({ odds: ODDS, cap_bb: CAP_BB, chip: CHIP, tables });
  }

  // Date range for the admin console: tickets, totals, a line per day and the float at the end of the range.
  if (path === '/insurance/range' && method === 'GET') {
    const q = new URL(req.url).searchParams, ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    const to = ok(q.get('to')) ? q.get('to') : (await businessDay(env, now)).day, from = ok(q.get('from')) && q.get('from') <= to ? q.get('from') : to;
    const rows = await all(env.DB.prepare('SELECT * FROM insurance_tickets WHERE day>=? AND day<=? ORDER BY id DESC LIMIT 2000').bind(from, to));
    for (const r of rows) { try { r.detail = JSON.parse(r.detail || '{}'); } catch { r.detail = {}; } }
    const byDay = new Map();
    for (const r of rows) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day).push(r); }
    const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, list]) => ({ day, ...totals(list) }));
    const f = await env.DB.prepare('SELECT day,balance,capital FROM insurance_float WHERE id=1').first();
    let float = null;
    if (f) {
      const net = async (d) => (await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN result='miss' THEN amount WHEN result='hit' THEN -payout ELSE 0 END),0) n FROM insurance_tickets WHERE day>? AND day<=?").bind(f.day, d).first()).n;
      float = { opening_day: f.day, opening: f.balance, capital: f.capital, balance: f.balance + (to > f.day ? await net(to) : 0) };
      for (const d of days) d.float_end = d.day > f.day ? f.balance + await net(d.day) : null;
    }
    return reply({ from, to, tickets: rows, totals: totals(rows), days, float });
  }
  if (path === '/insurance' && method === 'GET') {
    const url = new URL(req.url);
    const bd = await businessDay(env, now, url.searchParams.get('day'));
    const rows = await all(env.DB.prepare('SELECT * FROM insurance_tickets WHERE day=? ORDER BY id DESC').bind(bd.day));
    for (const r of rows) { try { r.detail = JSON.parse(r.detail || '{}'); } catch { r.detail = {}; } }
    // Insurance float: the cash set aside for insurance, from the last closed balance plus every settled ticket since.
    const f = await env.DB.prepare('SELECT day,balance,capital FROM insurance_float WHERE id=1').first();
    let float = null;
    if (f) {
      const since = await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN result='miss' THEN amount WHEN result='hit' THEN -payout ELSE 0 END),0) net FROM insurance_tickets WHERE day>? AND day<=?").bind(f.day, bd.day).first();
      float = { opening_day: f.day, opening: f.balance, capital: f.capital, balance: f.balance + (bd.day > f.day ? since.net : 0) };
    }
    const corrections = rows.length ? (await all(env.DB.prepare('SELECT * FROM insurance_corrections WHERE day=? ORDER BY id').bind(bd.day))).map(fixCorr) : [];
    return reply({ day: bd.day, is_today: bd.is_today, tickets: rows, totals: totals(rows), float, corrections });
  }

  if (path === '/insurance' && method === 'POST') {
    let b = {}; try { b = await req.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const players = int(b.players), outs = int(b.outs), pot = int(b.pot_amount), amount = int(b.amount);
    const bb = bigBlind(b.blinds), odds = oddsFor(players, outs);
    if (!bb) return reply({ error: 'Pick the table level.' }, 400);
    if (![2, 3, 4].includes(players)) return reply({ error: 'Players in the pot must be 2, 3 or 4.' }, 400);
    if (!odds) return reply({ error: outs > 15 ? 'More than 15 outs: insurance is not sold.' : 'No outs: nothing to insure.' }, 400);
    if (!(pot > 0)) return reply({ error: 'Enter the pot amount.' }, 400);
    const max = maxBuy(pot, bb, odds);
    if (!(amount > 0)) return reply({ error: 'Enter the amount to buy.' }, 400);
    if (amount > max) return reply({ error: `The most that can be bought is ${n(max)}.` }, 400);
    if (!['flop', 'turn'].includes(b.street)) return reply({ error: 'Street must be flop or turn.' }, 400);
    const potName = POTS.includes(b.pot) ? b.pot : 'Main';
    const payout = Math.round(amount * odds);
    const bd = await businessDay(env, now);
    // One ticket per pot per street in a hand: a second tap on Confirm returns the ticket already sold.
    if (b.hand_id) {
      const dup = await env.DB.prepare("SELECT * FROM insurance_tickets WHERE day=? AND table_name=? AND pot=? AND street=? AND result<>'void' AND json_extract(detail,'$.hand_id')=? ORDER BY id LIMIT 1")
        .bind(bd.day, str(b.table || '', 10), potName, b.street, String(b.hand_id)).first();
      if (dup) { dup.detail = JSON.parse(dup.detail || '{}'); return reply({ ticket: dup, duplicate: true }); }
    }
    const detail = JSON.stringify({ hands: b.hands, board: b.board, out_cards: b.out_cards, leader: b.leader, hand_id: b.hand_id, buyer: b.buyer, seats: b.seats }).slice(0, 4000);
    const row = await env.DB.prepare(`INSERT INTO insurance_tickets(day,created_at,created_by,table_name,blinds,street,pot,players,outs,odds,pot_amount,max_buy,amount,payout,result,detail)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?) RETURNING *`)
      .bind(bd.day, now, str(who, 60), str(b.table || '', 10), str(b.blinds, 20), b.street, potName, players, outs, odds, pot, max, amount, payout, detail).first();
    await audit(env, now, who, 'insurance.sell', `${b.table || ''} ${potName} pot ${n(pot)} · ${players} players · ${outs} outs × ${odds} · sold ${n(amount)} (pays ${n(payout)}, max ${n(max)})`).run();
    row.detail = JSON.parse(row.detail);
    return reply({ ticket: row });
  }

  if (path === '/insurance/float' && method === 'PUT') {
    if (role !== 'master') return reply({ error: 'Only the master account can set the insurance float.' }, 403);
    let b = {}; try { b = await req.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const balance = int(b.balance), capital = int(b.capital);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.day || '') || !(balance >= 0) || !(capital >= 0)) return reply({ error: 'Enter the closing day, its balance and the starting capital.' }, 400);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO insurance_float(id,day,balance,capital,updated_by,updated_at) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day,balance=excluded.balance,capital=excluded.capital,updated_by=excluded.updated_by,updated_at=excluded.updated_at').bind(b.day, balance, capital, str(who, 60), now),
      audit(env, now, who, 'insurance.float', `Insurance float closed ${b.day} at ${n(balance)} (starting capital ${n(capital)})`)
    ]);
    return reply({ ok: true });
  }
  // Correction requests: anyone signed in (the supervisor) asks with a reason; only the owner (master) decides, also with a reason.
  if (path === '/insurance/corrections' && method === 'GET') {
    const st = new URL(req.url).searchParams.get('status');
    const rows = await all(st === 'pending'
      ? env.DB.prepare("SELECT c.*, t.table_name, t.pot, t.street, t.odds, t.outs, t.created_at AS sold_at FROM insurance_corrections c LEFT JOIN insurance_tickets t ON t.id=c.ticket_id WHERE c.status='pending' ORDER BY c.id")
      : env.DB.prepare('SELECT c.*, t.table_name, t.pot, t.street, t.odds, t.outs, t.created_at AS sold_at FROM insurance_corrections c LEFT JOIN insurance_tickets t ON t.id=c.ticket_id ORDER BY c.id DESC LIMIT 200'));
    return reply({ corrections: rows.map(fixCorr) });
  }
  const cm = /^\/insurance\/corrections\/(\d+)\/decide$/.exec(path);
  if (cm && method === 'POST') {
    if (role !== 'master') return reply({ error: 'Only the owner can approve or reject a correction.' }, 403);
    let b = {}; try { b = await req.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const note = str(b.note || '', 300).trim();
    if (!note) return reply({ error: 'Write the reason for your decision.' }, 400);
    const c = await env.DB.prepare('SELECT * FROM insurance_corrections WHERE id=?').bind(Number(cm[1])).first();
    if (!c) return reply({ error: 'Request not found.' }, 404);
    if (c.status !== 'pending') return reply({ error: 'This request was already decided.' }, 409);
    fixCorr(c);
    const t = await env.DB.prepare('SELECT * FROM insurance_tickets WHERE id=?').bind(c.ticket_id).first();
    const label = t ? `${t.table_name} ${t.pot} ticket #${t.id}` : `ticket #${c.ticket_id}`;
    if (b.approve !== true) {
      await env.DB.batch([
        env.DB.prepare("UPDATE insurance_corrections SET status='rejected',decided_at=?,decided_by=?,decision_note=? WHERE id=? AND status='pending'").bind(now, str(who, 60), note, c.id),
        audit(env, now, who, 'insurance.correction.reject', `${label}: correction #${c.id} (${corrText(c.before, c.after)}) rejected: ${note}`)
      ]);
      return reply({ ok: true, status: 'rejected' });
    }
    if (!t) return reply({ error: 'The ticket no longer exists.' }, 409);
    if (t.result !== c.before.result || t.amount !== c.before.amount || t.payout !== c.before.payout)
      return reply({ error: 'The ticket changed after this request was made. Reject it and ask for a new request.' }, 409);
    const a = c.after, settled = a.result === 'pending' ? [null, null] : [t.settled_at || now, t.settled_by || str(who, 60)];
    await env.DB.batch([
      env.DB.prepare('UPDATE insurance_tickets SET result=?,amount=?,payout=?,settled_at=?,settled_by=?,void_reason=? WHERE id=?')
        .bind(a.result, a.amount, a.payout, settled[0], settled[1], a.result === 'void' ? str(`Correction #${c.id}: ${c.reason}`, 200) : (t.result === 'void' ? null : t.void_reason), t.id),
      env.DB.prepare("UPDATE insurance_corrections SET status='approved',decided_at=?,decided_by=?,decision_note=? WHERE id=? AND status='pending'").bind(now, str(who, 60), note, c.id),
      audit(env, now, who, 'insurance.correction.approve', `${label}: correction #${c.id} approved (${corrText(c.before, c.after)}). Asked by ${c.requested_by}: ${c.reason}. Owner: ${note}`)
    ]);
    return reply({ ok: true, status: 'approved' });
  }
  const rm = /^\/insurance\/(\d+)\/correct$/.exec(path);
  if (rm && method === 'POST') {
    let b = {}; try { b = await req.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const t = await env.DB.prepare('SELECT * FROM insurance_tickets WHERE id=?').bind(Number(rm[1])).first();
    if (!t) return reply({ error: 'Ticket not found.' }, 404);
    const reason = str(b.reason || '', 300).trim();
    if (!reason) return reply({ error: 'Write what went wrong and why it should be corrected.' }, 400);
    const before = { result: t.result, amount: t.amount, payout: t.payout };
    const after = { result: b.result ?? t.result, amount: b.amount === undefined ? t.amount : int(b.amount), payout: b.payout === undefined ? t.payout : int(b.payout) };
    if (!RESULTS.includes(after.result)) return reply({ error: 'Unknown result.' }, 400);
    if (!(after.amount >= 0) || !(after.payout >= 0)) return reply({ error: 'Amounts must be whole numbers, zero or more.' }, 400);
    if (!corrText(before, after)) return reply({ error: 'Nothing would change.' }, 400);
    if (await env.DB.prepare("SELECT id FROM insurance_corrections WHERE ticket_id=? AND status='pending'").bind(t.id).first())
      return reply({ error: 'This ticket already has a correction waiting for the owner.' }, 409);
    const row = await env.DB.prepare('INSERT INTO insurance_corrections(ticket_id,day,requested_at,requested_by,reason,before,after) VALUES(?,?,?,?,?,?,?) RETURNING *')
      .bind(t.id, t.day, now, str(who, 60), reason, JSON.stringify(before), JSON.stringify(after)).first();
    await audit(env, now, who, 'insurance.correction.request', `${t.table_name} ${t.pot} ticket #${t.id}: asks ${corrText(before, after)} · ${reason}`).run();
    return reply({ correction: fixCorr(row) });
  }
  const m = /^\/insurance\/(\d+)\/(settle|void)$/.exec(path);
  if (m && method === 'POST') {
    let b = {}; try { b = await req.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const t = await env.DB.prepare('SELECT * FROM insurance_tickets WHERE id=?').bind(Number(m[1])).first();
    if (!t) return reply({ error: 'Ticket not found.' }, 404);
    if (m[2] === 'settle') {
      if (t.result !== 'pending') return reply({ error: 'This ticket is already settled.' }, 409);
      const hit = b.hit === true;
      await env.DB.batch([
        env.DB.prepare('UPDATE insurance_tickets SET result=?,result_card=?,settled_at=?,settled_by=? WHERE id=? AND result=\'pending\'').bind(hit ? 'hit' : 'miss', str(b.card || '', 4), now, str(who, 60), t.id),
        audit(env, now, who, 'insurance.settle', `${t.table_name} ${t.pot} ticket #${t.id}: ${b.card || ''} ${hit ? `hit → house paid ${n(t.payout)} (no premium taken)` : `missed → house takes the premium ${n(t.amount)}`}`)
      ]);
      return reply({ ok: true, result: hit ? 'hit' : 'miss' });
    }
    if (role === 'staff') return reply({ error: 'Only a manager can void a ticket.' }, 403);
    const reason = str(b.reason || '', 200);
    if (!reason) return reply({ error: 'Write the reason.' }, 400);
    await env.DB.batch([
      env.DB.prepare("UPDATE insurance_tickets SET result='void',void_reason=?,settled_at=?,settled_by=? WHERE id=?").bind(reason, now, str(who, 60), t.id),
      audit(env, now, who, 'insurance.void', `${t.table_name} ${t.pot} ticket #${t.id} (${n(t.amount)}, was ${t.result}) voided: ${reason}`)
    ]);
    return reply({ ok: true });
  }
  return null;
}
