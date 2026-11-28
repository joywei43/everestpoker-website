// Cage ↔ PPM: buy-ins, add-ons and cash-outs are recorded once, at the cage, and PPM follows.
//   POST /ppm/cage-event  {key, kind:'buyin'|'cashout'|'adjust', member_no, amount}  (adjust: signed change to the buy-in after a cage correction)
//        buy-in of a seated player → add-on on that seat; otherwise → "waiting for a seat".
//        cash-out of a seated player → the seat is left with that cash-out (session written as at Leave).
//   GET  /ppm/waiting     players waiting for a seat (shown in PPM as a pop-up and on the cage desk)
//   POST /ppm/seat        {id, table_id, seat_id} seat a waiting player (PPM or the cage desk)
//   POST /ppm/waiting/:id/remove   take someone off the waiting list (e.g. left without playing)
import { ingestPpm, matchRefs, normNo, str, displayName } from './members.mjs';
import { auditStmt } from './audit.mjs';
import { recordTableRuns } from './operation.mjs';

const pad = (n) => String(n).padStart(2, '0');
// PPM stores local wall-clock times (Manila, UTC+8) as "YYYY-MM-DD HH:MM:SS".
export const ppmLocal = (ms) => { const d = new Date(ms + 8 * 3600e3); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
const hms = (s) => { s = Math.max(0, Math.floor(s)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`; };
const activeSecs = (s, now) => s.status === 'seated' && s.lastActiveStart != null ? s.activeSeconds + Math.max(0, Math.floor((now - s.lastActiveStart) / 1000)) : s.activeSeconds;
const restSecs = (s, now) => s.status === 'rest' && s.lastRestStart != null ? s.restSeconds + Math.max(0, Math.floor((now - s.lastRestStart) / 1000)) : s.restSeconds;
const emptySeat = (id) => ({ id, memberId: '', status: 'idle', activeSeconds: 0, restSeconds: 0, lastActiveStart: null, lastRestStart: null, buyInAmount: 0, transferNote: null, sessionStart: null, selectedForBatch: false });

// The same session row PPM writes at Leave.
function sessionRow(t, s, nowMs, cashOut) {
  const active = activeSecs(s, nowMs), rest = restSecs(s, nowMs);
  return { date: ppmLocal(nowMs).slice(0, 10), tableId: t.id, tableName: t.name, seatId: s.id, memberId: s.memberId, startTime: s.sessionStart, endTime: ppmLocal(nowMs),
    activeSeconds: active, restSeconds: rest, durationHMS: hms(active), buyInDisplay: s.transferNote ? s.transferNote : String(s.buyInAmount), buyInAmount: s.transferNote ? null : s.buyInAmount,
    transferNote: s.transferNote, cashOutAmount: cashOut, busted: cashOut === 0, closedBy: 'cage' };
}

// Change the PPM state on the server, with the same version check and public-room update as a PPM save.
async function changePpm(env, now, user, mutate) {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 60 + Math.random() * 140 * attempt)); // PPM screens save often: wait a moment and read again
    const row = await env.DB.prepare('SELECT version,data FROM ppm WHERE id=1').first();
    const room = await env.DB.prepare('SELECT version,data FROM room WHERE id=1').first();
    const ts = JSON.parse(row.data);
    const out = await mutate(ts);
    if (!out || !out.changed) return { ...(out || {}), version: row.version, tables: ts };
    const state = JSON.parse(room.data);
    state.occupied = ts.map((t) => t.seats.map((s) => t.isRunning && s.status !== 'idle' ? 1 : 0));
    state.games = ts.map((t) => t.blinds); state.tableTypes = ts.map((t) => t.gameType); state.tableOpen = ts.map((t) => t.isRunning); state.count = '4';
    const res = await env.DB.batch([
      env.DB.prepare('UPDATE ppm SET version=version+1,data=? WHERE id=1 AND version=? AND (SELECT version FROM room WHERE id=1)=?').bind(JSON.stringify(ts), row.version, room.version),
      env.DB.prepare('UPDATE room SET version=version+1,data=? WHERE id=1 AND changes()=1').bind(JSON.stringify(state)),
    ]);
    if (!res[0].meta.changes) continue; // someone saved PPM at the same moment: read again and redo
    let sync = null;
    try { sync = await ingestPpm(env, ts, Math.floor(now)); } catch (e) { try { await auditStmt(env, Math.floor(now), user || 'cage', 'ppm.sync_error', 'Could not copy finished PPM sessions: ' + String(e && e.message || e).slice(0, 200)).run(); } catch {} }
    try { await recordTableRuns(env, ts, Math.floor(now)); } catch {}
    return { ...out, version: row.version + 1, tables: ts, sync };
  }
  throw Object.assign(new Error('PPM is busy. Try again.'), { status: 409 });
}

// Where is this member seated? (seat refs are member numbers or nicknames typed in PPM)
async function findSeat(env, ts, memberId) {
  const refs = ts.flatMap((t) => t.seats.filter((s) => s.status !== 'idle' && s.memberId).map((s) => s.memberId));
  if (!refs.length) return null;
  const match = await matchRefs(env, refs);
  for (const t of ts) for (const s of t.seats) if (s.status !== 'idle' && s.memberId && match(s.memberId) === memberId) return { t, s };
  return null;
}
const memberRow = (env, no) => env.DB.prepare('SELECT * FROM members WHERE member_no=? COLLATE NOCASE').bind(normNo(no)).first();

export const isPpmLinkPath = (path) => path === '/ppm/waiting' || path === '/ppm/cage-event' || path === '/ppm/seat' || /^\/ppm\/waiting\/\d+\/remove$/.test(path);

export async function handlePpmLink(req, env, path, nowSec, reply, user, role) {
  const nowMs = nowSec * 1000;
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : null;

  if (path === '/ppm/waiting' && req.method === 'GET') {
    const rows = (await env.DB.prepare("SELECT w.id,w.member_no,w.name,w.amount,w.created_at,w.created_by,m.nationality,m.nickname FROM ppm_waiting w LEFT JOIN members m ON m.id=w.member_id WHERE w.status='waiting' ORDER BY w.created_at,w.id LIMIT 50").all()).results || [];
    return reply({ waiting: rows });
  }

  if (path === '/ppm/cage-event' && req.method === 'POST') {
    const key = str(body.key, 80), kind = str(body.kind, 10), amount = Number(body.amount);
    if (!key || !['buyin', 'cashout', 'adjust'].includes(kind) || !Number.isSafeInteger(amount) || (kind !== 'adjust' && amount < 0)) return reply({ error: 'Invalid cage event.' }, 400);
    const seen = await env.DB.prepare('SELECT result FROM ppm_events WHERE key=?').bind(key).first();
    if (seen) return reply({ ok: true, repeated: true, result: JSON.parse(seen.result || '{}') });
    const m = await memberRow(env, str(body.member_no, 20));
    if (!m) return reply({ ok: true, result: { action: 'no_member' } }); // a name without a member number: PPM is not changed
    const name = m.nickname || displayName(m);
    let result;
    // The member already left the seat (for example a second cash-out, or a correction after Leave):
    // change their last finished game session of the last 12 hours instead.
    const lastSession = async () => env.DB.prepare('SELECT id FROM play_sessions WHERE member_id=? AND end_at>=? ORDER BY end_at DESC LIMIT 1').bind(m.id, nowSec - 12 * 3600).first();
    if (kind === 'adjust') {
      // A cage correction changed a buy-in: change the seat's total (or the waiting amount). Never below 0; the seat is not freed.
      const out = await changePpm(env, nowMs, user, async (ts) => {
        const at = await findSeat(env, ts, m.id);
        if (!at) return { changed: false, action: 'not_seated' };
        at.s.buyInAmount = Math.max(0, (Number(at.s.buyInAmount) || 0) + amount);
        return { changed: true, action: 'adjusted', table: at.t.name, seat: at.s.id };
      });
      if (out.action === 'not_seated') {
        const w = await env.DB.prepare("SELECT id FROM ppm_waiting WHERE member_id=? AND status='waiting'").bind(m.id).first();
        if (w) await env.DB.prepare('UPDATE ppm_waiting SET amount=MAX(0,amount+?) WHERE id=?').bind(amount, w.id).run();
        let ls = null;
        if (!w && (ls = await lastSession())) await env.DB.prepare('UPDATE play_sessions SET buy_in=MAX(0,COALESCE(buy_in,0)+?) WHERE id=?').bind(amount, ls.id).run();
        result = { action: w ? 'adjusted_waiting' : ls ? 'session_updated' : 'not_seated' };
      } else result = { action: 'adjusted', table: out.table, seat: out.seat };
    } else if (kind === 'buyin') {
      const out = await changePpm(env, nowMs, user, async (ts) => {
        const at = await findSeat(env, ts, m.id);
        if (!at) return { changed: false, action: 'waiting' };
        at.s.buyInAmount = (Number(at.s.buyInAmount) || 0) + amount;
        // An add-on after a Cash Out Request means the player keeps playing: cancel the request and restart the clock.
        if (at.s.cashoutAsked) {
          if (at.s.status === 'rest') Object.assign(at.s, { status: 'seated', restSeconds: restSecs(at.s, nowMs), lastRestStart: null, lastActiveStart: nowMs });
          at.s.cashoutAsked = null;
        }
        return { changed: true, action: 'addon', table: at.t.name, seat: at.s.id };
      });
      if (out.action === 'waiting') {
        const w = await env.DB.prepare("SELECT id FROM ppm_waiting WHERE member_id=? AND status='waiting'").bind(m.id).first();
        if (w) await env.DB.prepare('UPDATE ppm_waiting SET amount=amount+? WHERE id=?').bind(amount, w.id).run();
        else await env.DB.prepare("INSERT INTO ppm_waiting(member_id,member_no,name,amount,status,created_at,created_by) VALUES(?,?,?,?,'waiting',?,?)").bind(m.id, m.member_no, name, amount, nowSec, str(user || 'cage', 60)).run();
        result = { action: 'waiting' };
      } else result = { action: 'addon', table: out.table, seat: out.seat };
    } else {
      const out = await changePpm(env, nowMs, user, async (ts) => {
        const at = await findSeat(env, ts, m.id);
        if (!at) return { changed: false, action: 'not_seated' };
        at.t.sessions = [...(at.t.sessions || []), sessionRow(at.t, at.s, nowMs, amount)];
        const i = at.t.seats.findIndex((x) => x.id === at.s.id); at.t.seats[i] = emptySeat(at.s.id);
        return { changed: true, action: 'left', table: at.t.name, seat: at.s.id };
      });
      // Bought in but never seated, then cashed out: off the waiting list.
      await env.DB.prepare("UPDATE ppm_waiting SET status='gone',seated_at=? WHERE member_id=? AND status='waiting'").bind(nowSec, m.id).run();
      let ls = null;
      if (out.action !== 'left' && (ls = await lastSession())) await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO session_results(session_id,cash_out,busted,entered_by,updated_at) VALUES(?,0,0,'cage',?)").bind(ls.id, nowSec),
        env.DB.prepare("UPDATE session_results SET cash_out=cash_out+?,busted=0,entered_by='cage',updated_at=? WHERE session_id=?").bind(amount, nowSec, ls.id),
      ]);
      result = out.action === 'left' ? { action: 'left', table: out.table, seat: out.seat } : ls ? { action: 'session_updated' } : { action: 'not_seated' };
    }
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO ppm_events(key,at,result) VALUES(?,?,?)').bind(key, nowSec, JSON.stringify(result)),
      env.DB.prepare('DELETE FROM ppm_events WHERE at<?').bind(nowSec - 7 * 86400),
      auditStmt(env, nowSec, user || 'cage', 'ppm.cage', `${kind === 'buyin' ? 'Buy-in' : kind === 'adjust' ? 'Buy-in correction' : 'Cash-out'} ₱${amount} ${name} #${m.member_no} → ${result.action === 'addon' ? 'add-on at ' + result.table + ' #' + result.seat : result.action === 'left' ? 'left ' + result.table + ' #' + result.seat : result.action === 'waiting' ? 'waiting for a seat' : 'not seated in PPM'}`, m.id),
    ]);
    return reply({ ok: true, result });
  }

  if (path === '/ppm/seat' && req.method === 'POST') {
    const id = Number(body.id), tableId = Number(body.table_id), seatId = Number(body.seat_id);
    const w = await env.DB.prepare('SELECT * FROM ppm_waiting WHERE id=?').bind(id).first();
    if (!w || w.status !== 'waiting') return reply({ error: 'This player is no longer waiting.' }, 409);
    const out = await changePpm(env, nowMs, user, async (ts) => {
      const t = ts.find((x) => x.id === tableId);
      if (!t) return { error: 'No such table.' };
      if (!t.isRunning) return { error: `${t.name} is not running. Start the table in PPM first.` };
      const s = t.seats.find((x) => x.id === seatId);
      if (!s || s.status !== 'idle') return { error: `Seat ${seatId} at ${t.name} is taken.` };
      if (await findSeat(env, ts, w.member_id)) return { error: `${w.name} is already seated.` };
      Object.assign(s, { ...emptySeat(seatId), status: 'seated', memberId: w.member_no, lastActiveStart: nowMs, sessionStart: ppmLocal(nowMs), buyInAmount: w.amount, seatedBy: str(user || '', 60) });
      return { changed: true, table: t.name };
    });
    if (out.error) return reply({ error: out.error }, 409);
    await env.DB.batch([
      env.DB.prepare("UPDATE ppm_waiting SET status='seated',seated_at=?,seated_by=?,table_name=?,seat=? WHERE id=? AND status='waiting'").bind(nowSec, str(user || '', 60), out.table, seatId, id),
      auditStmt(env, nowSec, user || 'staff', 'ppm.seat', `${w.name} #${w.member_no} seated at ${out.table} #${seatId} (buy-in ₱${w.amount} from the cage)`, w.member_id),
    ]);
    return reply({ ok: true, version: out.version, tables: out.tables });
  }

  const rm = /^\/ppm\/waiting\/(\d+)\/remove$/.exec(path);
  if (rm && req.method === 'POST') {
    const w = await env.DB.prepare('SELECT * FROM ppm_waiting WHERE id=?').bind(Number(rm[1])).first();
    if (!w || w.status !== 'waiting') return reply({ ok: true, unchanged: true });
    await env.DB.batch([
      env.DB.prepare("UPDATE ppm_waiting SET status='gone',seated_at=?,seated_by=? WHERE id=?").bind(nowSec, str(user || '', 60), w.id),
      auditStmt(env, nowSec, user || 'staff', 'ppm.waiting_removed', `${w.name} #${w.member_no} taken off the waiting-for-a-seat list${body.reason ? ': ' + str(body.reason, 120) : ''}`, w.member_id),
    ]);
    return reply({ ok: true });
  }
  return null;
}
