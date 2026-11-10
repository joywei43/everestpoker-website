// Operation Report: one row per business day over a date range, with totals.
// Revenue and the Bad Beat Jackpot are entered by managers per day; everything else comes from PPM.
import { str, localDate, dayStart, liveSeats, displayName } from './members.mjs';
import { businessDay, dayOpenFromRuns, runsAround } from './operation.mjs';

const HOUR = 3600, DAY = 86400, TZ = 8 * HOUR, MAX_DAYS = 120;
const all = async (stmt) => (await stmt.all()).results || [];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const addDays = (d, n) => localDate(dayStart(d) + n * DAY + HOUR);
const money = (v) => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[,\s₱]/g, '')); return Number.isFinite(n) && n >= 0 && n <= 1e11 ? Math.round(n) : NaN; };
const cents = (v) => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[,\s₱]/g, '')); return Number.isFinite(n) && n >= 0 && n <= 1e11 ? Math.round(n * 100) : NaN; };
const levelOf = (blinds, game) => `${blinds || ''} ${game || ''}`.trim() || 'Unknown';

// Same business-day rule as Live Operation (see dayOpenFromRuns).
async function dayOpenings(env, from, toPlusOne) {
  const runs = await runsAround(env, from, toPlusOne);
  const opens = {};
  for (let d = from; d <= toPlusOne; d = addDays(d, 1)) opens[d] = dayOpenFromRuns(d, runs);
  return opens;
}

export async function handleReport(req, env, path, now, reply, user, role) {
  if (role === 'staff') return reply({ error: 'Manager only.' }, 403);
  const method = req.method;

  // Save one day's revenue and jackpot figures.
  const m = /^\/report\/day\/(\d{4}-\d{2}-\d{2})$/.exec(path);
  if (m && method === 'PUT') {
    const day = m[1];
    if (!isDate(day)) return reply({ error: 'Bad date.' }, 400);
    if (day > (await businessDay(env, now)).day) return reply({ error: 'That business day has not started yet.' }, 400);
    let b = {}; try { b = await req.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const who = str(user || 'staff', 60), show = (c) => (c == null ? '—' : (c / 100).toFixed(2));
    const stmts = [], notes = [];
    // Revenue per table: { tables: { T1: 50000, T2: '' } } — blank removes that table's entry. The day's revenue is the sum.
    if (b.tables && typeof b.tables === 'object') {
      const entries = Object.entries(b.tables).slice(0, 12).map(([k, v]) => [str(k, 10), money(v)]);
      if (entries.some(([k, v]) => !k || Number.isNaN(v))) return reply({ error: 'Revenue must be 0 or more.' }, 400);
      for (const [k, v] of entries) {
        stmts.push(v == null ? env.DB.prepare('DELETE FROM table_revenue WHERE day=? AND table_name=?').bind(day, k)
          : env.DB.prepare('INSERT INTO table_revenue(day,table_name,revenue,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(day,table_name) DO UPDATE SET revenue=excluded.revenue,updated_by=excluded.updated_by,updated_at=excluded.updated_at').bind(day, k, v, who, now));
        notes.push(`${k} ${v == null ? '—' : v}`);
      }
      stmts.push(env.DB.prepare(`INSERT INTO daily_reports(day,revenue,bbj_in,bbj_out,note,updated_by,updated_at) VALUES(?,(SELECT SUM(revenue) FROM table_revenue WHERE day=?),NULL,NULL,'',?,?)
        ON CONFLICT(day) DO UPDATE SET revenue=(SELECT SUM(revenue) FROM table_revenue WHERE day=excluded.day),updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(day, day, who, now));
    } else if ('revenue' in b) {
      const revenue = money(b.revenue);
      if (Number.isNaN(revenue)) return reply({ error: 'Amounts must be 0 or more.' }, 400);
      stmts.push(env.DB.prepare(`INSERT INTO daily_reports(day,revenue,bbj_in,bbj_out,note,updated_by,updated_at) VALUES(?,?,NULL,NULL,'',?,?)
        ON CONFLICT(day) DO UPDATE SET revenue=excluded.revenue,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(day, revenue, who, now));
      notes.push(`revenue ${revenue ?? '—'}`);
    }
    if ('bbj_main' in b || 'bbj_reserve' in b || 'bbj_paid' in b) {
      const main = cents(b.bbj_main), reserve = cents(b.bbj_reserve), paid = cents(b.bbj_paid);
      if ([main, reserve, paid].some((v) => Number.isNaN(v))) return reply({ error: 'Amounts must be 0 or more.' }, 400);
      stmts.push(env.DB.prepare(`INSERT INTO bbj_daily(day,main_cents,reserve_cents,paid_cents,updated_by,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(day) DO UPDATE SET main_cents=excluded.main_cents,reserve_cents=excluded.reserve_cents,paid_cents=excluded.paid_cents,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
        .bind(day, main, reserve, paid, who, now));
      notes.push(`BBJ main ${show(main)}, 1st reserved ${show(reserve)}, paid ${show(paid)}`);
    }
    if ('bbj_amount' in b) {
      const amount = cents(b.bbj_amount);
      if (Number.isNaN(amount)) return reply({ error: 'BBJ amount must be 0 or more.' }, 400);
      stmts.push(amount == null ? env.DB.prepare('DELETE FROM bbj_collect WHERE day=?').bind(day)
        : env.DB.prepare('INSERT INTO bbj_collect(day,amount_cents,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(day) DO UPDATE SET amount_cents=excluded.amount_cents,updated_by=excluded.updated_by,updated_at=excluded.updated_at').bind(day, amount, who, now));
      notes.push(`BBJ collected ${show(amount)}`);
    }
    if (!stmts.length) return reply({ error: 'Nothing to save.' }, 400);
    stmts.push(env.DB.prepare("INSERT INTO audit_log(at,actor,action,member_id,detail) VALUES(?,?,'report.day',NULL,?)").bind(now, who, `${day}: ${notes.join(' · ')}`));
    await env.DB.batch(stmts);
    return reply({ ok: true });
  }
  // Jackpot hit: the paid amount comes out of Main, then 1st Reserved becomes the new Main.
  if (path === '/report/bbj/payout' && method === 'POST') {
    let b = {}; try { b = await req.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const day = b.day, paid = cents(b.paid);
    if (!isDate(day) || day > (await businessDay(env, now)).day) return reply({ error: 'Pick the business day of the jackpot.' }, 400);
    if (paid == null || Number.isNaN(paid) || paid <= 0) return reply({ error: 'Enter the amount paid out.' }, 400);
    const who = str(user || 'staff', 60), note = str(b.note || '', 200);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO bbj_payouts(day,paid_cents,note,created_by,created_at) VALUES(?,?,?,?,?)').bind(day, paid, note, who, now),
      env.DB.prepare("INSERT INTO audit_log(at,actor,action,member_id,detail) VALUES(?,?,'report.bbj_payout',NULL,?)").bind(now, who, `${day}: BBJ paid out ${(paid / 100).toFixed(2)}${note ? ' · ' + note : ''}`)]);
    return reply({ ok: true });
  }
  const pm = /^\/report\/bbj\/payout\/(\d+)$/.exec(path);
  if (pm && method === 'DELETE') {
    if (role !== 'master') return reply({ error: 'Only the master account can delete a payout.' }, 403);
    const row = await env.DB.prepare('SELECT * FROM bbj_payouts WHERE id=?').bind(Number(pm[1])).first();
    if (!row) return reply({ error: 'Payout not found.' }, 404);
    await env.DB.batch([env.DB.prepare('DELETE FROM bbj_payouts WHERE id=?').bind(row.id),
      env.DB.prepare("INSERT INTO audit_log(at,actor,action,member_id,detail) VALUES(?,?,'report.bbj_payout',NULL,?)").bind(now, str(user, 60), `Deleted BBJ payout of ${row.day} (${(row.paid_cents / 100).toFixed(2)})`)]);
    return reply({ ok: true });
  }
  if (path === '/report/bbj/opening' && method === 'PUT') {
    if (role !== 'master') return reply({ error: 'Only the master account can set the opening balance.' }, 403);
    let b = {}; try { b = await req.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const main = cents(b.main), reserve = cents(b.reserve);
    if (!isDate(b.day) || main == null || reserve == null || Number.isNaN(main) || Number.isNaN(reserve)) return reply({ error: 'Enter the start day, Main and 1st Reserved.' }, 400);
    await env.DB.batch([env.DB.prepare('INSERT INTO bbj_opening(id,day,main_cents,reserve_cents,updated_by,updated_at) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day,main_cents=excluded.main_cents,reserve_cents=excluded.reserve_cents,updated_by=excluded.updated_by,updated_at=excluded.updated_at').bind(b.day, main, reserve, str(user, 60), now),
      env.DB.prepare("INSERT INTO audit_log(at,actor,action,member_id,detail) VALUES(?,?,'report.bbj_opening',NULL,?)").bind(now, str(user, 60), `BBJ opening balance before ${b.day}: Main ${(main / 100).toFixed(2)}, 1st Reserved ${(reserve / 100).toFixed(2)}`)]);
    return reply({ ok: true });
  }
  if ((path !== '/report' && path !== '/report/table') || method !== 'GET') return null;

  const url = new URL(req.url);
  const current = await businessDay(env, now);
  const today = current.day; // before the day opens (usually noon) it is still yesterday's business day
  let to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : today;
  let from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : addDays(to, -6);
  if (to > today) to = today;
  if (from > to) [from, to] = [to, from];
  if ((dayStart(to) - dayStart(from)) / DAY >= MAX_DAYS) from = addDays(to, -(MAX_DAYS - 1));
  if (path === '/report/table') return tableReport(env, url, now, reply, today, from, to);

  const after = addDays(to, 1);
  const opens = await dayOpenings(env, from, after);
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push({ day: d, start: opens[d], end: opens[addDays(d, 1)] });
  const start = opens[from], end = Math.min(opens[after], now);
  const dayOf = (t) => { for (const d of days) if (t >= d.start && t < d.end) return d; return null; };

  const rows = {};
  for (const d of days) rows[d.day] = { day: d.day, revenue: null, bbj_main: null, bbj_reserve: null, bbj_paid: null, bbj_growth: null, table_revenue: {}, table_seconds_by: {}, note: '', updated_by: '', table_seconds: 0, operating_seconds: 0, tables: [],
    visitors: 0, members: 0, new_members: 0, sessions: 0, play_seconds: 0, rest_seconds: 0, buy_in: 0, cash_out: 0, missing_cash_out: 0, levels: {} };
  const level = (r, name) => (r.levels[name] ||= { table_seconds: 0, play_seconds: 0, sessions: 0 });

  // Manager entries.
  for (const e of await all(env.DB.prepare('SELECT * FROM daily_reports WHERE day>=? AND day<=?').bind(from, to))) {
    Object.assign(rows[e.day], { revenue: e.revenue, note: e.note, updated_by: e.updated_by });
  }
  const byTable = {};
  for (const e of await all(env.DB.prepare('SELECT day,table_name,revenue FROM table_revenue WHERE day>=? AND day<=?').bind(from, to))) {
    rows[e.day].table_revenue[e.table_name] = e.revenue;
    (byTable[e.table_name] ||= { revenue: 0, table_seconds: 0, days: 0 }).revenue += e.revenue;
  }
  // Bad Beat Jackpot: the board amounts each day. Growth = change in Main + 1st Reserved since the last board, plus anything paid out.
  const pesos = (c) => (c == null ? null : c / 100);
  const prevBoard = await env.DB.prepare('SELECT day,main_cents,reserve_cents FROM bbj_daily WHERE day<? AND (main_cents IS NOT NULL OR reserve_cents IS NOT NULL) ORDER BY day DESC LIMIT 1').bind(from).first();
  const boardTotal = (r) => (r && (r.main_cents != null || r.reserve_cents != null) ? (r.main_cents || 0) + (r.reserve_cents || 0) : null);
  let lastTotal = boardTotal(prevBoard), latest = null, paidSum = 0;
  for (const e of await all(env.DB.prepare('SELECT * FROM bbj_daily WHERE day>=? AND day<=? ORDER BY day').bind(from, to))) {
    const r = rows[e.day], total = boardTotal(e);
    Object.assign(r, { bbj_main: pesos(e.main_cents), bbj_reserve: pesos(e.reserve_cents), bbj_paid: pesos(e.paid_cents) });
    if (!r.updated_by) r.updated_by = e.updated_by;
    paidSum += e.paid_cents || 0;
    if (total != null) { if (lastTotal != null) r.bbj_growth = pesos(total - lastTotal + (e.paid_cents || 0)); lastTotal = total; latest = e; }
  }
  const startTotal = boardTotal(prevBoard), endTotal = latest ? boardTotal(latest) : startTotal;
  const bbj = {
    as_of: latest ? latest.day : prevBoard ? prevBoard.day : null,
    main: pesos(latest ? latest.main_cents : prevBoard ? prevBoard.main_cents : null), reserve: pesos(latest ? latest.reserve_cents : prevBoard ? prevBoard.reserve_cents : null),
    before: pesos(startTotal), paid: pesos(paidSum), growth: startTotal != null && endTotal != null ? pesos(endTotal - startTotal + paidSum) : null
  };

  // Table time, split by business day and level.
  const runs = await all(env.DB.prepare('SELECT table_name,opened_at,closed_at,game_type,blinds FROM table_runs WHERE opened_at<? AND (closed_at IS NULL OR closed_at>?)').bind(end, start));
  const span = {}, used = {}, tableLevels = {};
  for (const r of runs) {
    const runEnd = Math.min(r.closed_at == null ? now : r.closed_at, now);
    for (const d of days) {
      const s = Math.max(r.opened_at, d.start), e = Math.min(runEnd, d.end);
      if (e <= s) continue;
      const row = rows[d.day];
      row.table_seconds += e - s;
      row.table_seconds_by[r.table_name] = (row.table_seconds_by[r.table_name] || 0) + (e - s);
      const tl = (tableLevels[r.table_name] ||= {}); tl[levelOf(r.blinds, r.game_type)] = (tl[levelOf(r.blinds, r.game_type)] || 0) + (e - s);
      const dl = ((row.table_level_seconds ||= {})[r.table_name] ||= {}); dl[levelOf(r.blinds, r.game_type)] = (dl[levelOf(r.blinds, r.game_type)] || 0) + (e - s);
      level(row, levelOf(r.blinds, r.game_type)).table_seconds += e - s;
      (used[d.day] ||= new Set()).add(r.table_name);
      const sp = (span[d.day] ||= [s, e]); sp[0] = Math.min(sp[0], s); sp[1] = Math.max(sp[1], e);
    }
  }
  for (const d of days) {
    if (span[d.day]) rows[d.day].operating_seconds = span[d.day][1] - span[d.day][0];
    rows[d.day].tables = used[d.day] ? [...used[d.day]].sort() : [];
  }

  // Players (finished PPM sessions, by the day they sat down).
  const sess = await all(env.DB.prepare(`SELECT ps.member_id, lower(ps.member_ref) ref, ps.start_at, ps.active_seconds, ps.rest_seconds, ps.buy_in, ps.game_type, ps.blinds, sr.cash_out, sr.session_id has_result
    FROM play_sessions ps LEFT JOIN session_results sr ON sr.session_id=ps.id WHERE ps.start_at>=? AND ps.start_at<?`).bind(start, end));
  const seen = {}, everyone = new Set(), everyMember = new Set();
  for (const s of sess) {
    const d = dayOf(s.start_at); if (!d) continue;
    const row = rows[d.day], who = s.member_id ? 'm' + s.member_id : 'r' + s.ref;
    const set = (seen[d.day] ||= { all: new Set(), members: new Set() });
    set.all.add(who); everyone.add(who);
    if (s.member_id) { set.members.add(who); everyMember.add(who); }
    row.sessions++; row.play_seconds += s.active_seconds; row.rest_seconds += s.rest_seconds;
    row.buy_in += s.buy_in || 0; row.cash_out += s.cash_out || 0;
    if (!s.has_result && s.buy_in != null) row.missing_cash_out++;
    const lv = level(row, levelOf(s.blinds, s.game_type)); lv.play_seconds += s.active_seconds; lv.sessions++;
  }
  // Players still at a table count too, on the day they sat down (time and buy-in so far, no cash-out yet).
  const liveNow = await liveSeats(env);
  for (const x of liveNow) {
    if (x.started == null || x.started < start || x.started >= end) continue;
    const d = dayOf(x.started); if (!d) continue;
    const row = rows[d.day], who = x.member_id ? 'm' + x.member_id : 'r' + String(x.ref).toLowerCase();
    const set = (seen[d.day] ||= { all: new Set(), members: new Set() });
    set.all.add(who); everyone.add(who);
    if (x.member_id) { set.members.add(who); everyMember.add(who); }
    row.sessions++; row.play_seconds += x.active_seconds; row.rest_seconds += x.rest_seconds; row.buy_in += x.buy_in || 0; row.playing_now = (row.playing_now || 0) + 1;
    const lv = level(row, levelOf(x.blinds, x.game_type)); lv.play_seconds += x.active_seconds; lv.sessions++;
  }
  for (const d of days) if (seen[d.day]) { rows[d.day].visitors = seen[d.day].all.size; rows[d.day].members = seen[d.day].members.size; }
  // New = members whose first game ever falls on that business day (not when the record was created).
  const firstGame = new Map();
  for (const { member_id, first } of await all(env.DB.prepare('SELECT member_id, MIN(start_at) first FROM play_sessions WHERE member_id IS NOT NULL GROUP BY member_id HAVING MIN(start_at)<?').bind(end))) firstGame.set(member_id, first);
  for (const x of liveNow) if (x.member_id && x.started != null && (!firstGame.has(x.member_id) || x.started < firstGame.get(x.member_id))) firstGame.set(x.member_id, x.started); // first game still in progress
  for (const first of firstGame.values()) { if (first < start || first >= end) continue; const d = dayOf(first); if (d) rows[d.day].new_members++; }

  // Totals across the range ("visits" adds up the days; "unique visitors" counts each player once).
  const list = days.map((d) => rows[d.day]);
  for (const r of list) r.in_progress = r.day === current.day && current.end > now;
  const sum = (k) => list.reduce((a, r) => a + (r[k] || 0), 0);
  const levels = {};
  for (const r of list) for (const [k, v] of Object.entries(r.levels)) {
    const t = (levels[k] ||= { table_seconds: 0, play_seconds: 0, sessions: 0, days: 0 });
    t.table_seconds += v.table_seconds; t.play_seconds += v.play_seconds; t.sessions += v.sessions; if (v.table_seconds || v.sessions) t.days++;
  }
  for (const r of list) for (const [k, sec] of Object.entries(r.table_seconds_by)) { const t = (byTable[k] ||= { revenue: 0, table_seconds: 0, days: 0 }); t.table_seconds += sec; t.days++; }
  // Big-blind hours: table hours × the big blind of the level played, so revenue can be shown as BB per hour.
  const bigBlind = (level) => { const m = /\/\s*(\d+)/.exec(level); return m ? Number(m[1]) : 0; };
  for (const [k, t] of Object.entries(byTable)) {
    t.levels = tableLevels[k] || {};
    t.bb_hours = Object.entries(t.levels).reduce((a, [lv, sec]) => a + (sec / 3600) * bigBlind(lv), 0);
    t.revenue_seconds = 0; t.revenue_bb_hours = 0; t.revenue_days = 0;
  }
  // Revenue per table hour / BB per hour only use days where that table's revenue has been entered,
  // so a day still in progress (or not entered yet) does not pull the averages down.
  for (const r of list) for (const [k, sec] of Object.entries(r.table_seconds_by)) {
    if (r.table_revenue[k] == null || !byTable[k]) continue;
    const t = byTable[k]; t.revenue_seconds += sec; t.revenue_days++;
    t.revenue_bb_hours += Object.entries((r.table_level_seconds || {})[k] || {}).reduce((a, [lv, x]) => a + (x / 3600) * bigBlind(lv), 0);
  }
  const totals = {
    days: list.length, open_days: list.filter((r) => r.table_seconds || r.sessions).length, entered_days: list.filter((r) => r.revenue != null).length,
    revenue: sum('revenue'), table_seconds: sum('table_seconds'), operating_seconds: sum('operating_seconds'),
    revenue_table_seconds: Object.values(byTable).reduce((a, t) => a + t.revenue_seconds, 0), revenue_bb_hours: Object.values(byTable).reduce((a, t) => a + t.revenue_bb_hours, 0),
    revenue_visits: list.filter((r) => r.revenue != null).reduce((a, r) => a + r.visitors, 0),
    visits: sum('visitors'), unique_visitors: everyone.size, unique_members: everyMember.size, new_members: sum('new_members'), sessions: sum('sessions'),
    tables: byTable, play_seconds: sum('play_seconds'), rest_seconds: sum('rest_seconds'), buy_in: sum('buy_in'), cash_out: sum('cash_out'), missing_cash_out: sum('missing_cash_out'), levels
  };
  const jackpot = await bbjLedger(env, from, to);
  for (const r of list) { const j = jackpot.rows.find((x) => x.day === r.day && x.kind === 'collect'); r.bbj_amount = j ? j.amount : null; }
  return reply({ from, to, today, days: list, totals, bbj, jackpot });
}

// Bad Beat Jackpot ledger. Each day's collection is split:
//   30% admin fee → Pagcor 25% (7.5%), CDC 5% (1.5%), Everest 70% (21%)   (as in the casino's monthly memo)
//   70% to the pot → Main 70% (49%), 1st Reserved 30% (21%)
// A payout takes the paid amount out of Main; 1st Reserved then becomes the new Main.
// On a day with a payout, the payout comes first (that day's box is counted the next day).
export function splitBbj(amountCents) {
  const taken = Math.round(amountCents * 0.3), pot = amountCents - taken;
  const pagcor = Math.round(taken * 0.25), cdc = Math.round(taken * 0.05), main = Math.round(pot * 0.7);
  return { taken, pagcor, cdc, everest: taken - pagcor - cdc, pot, main, reserve: pot - main };
}
export async function bbjLedger(env, from, to) {
  const p = (c) => Math.round(c) / 100;
  const opening = await env.DB.prepare('SELECT day,main_cents,reserve_cents FROM bbj_opening WHERE id=1').first();
  const empty = { opening: null, balance: null, rows: [], totals: null };
  if (!opening) return empty;
  const collects = await all(env.DB.prepare('SELECT day,amount_cents,updated_by FROM bbj_collect WHERE day>=? AND day<=? ORDER BY day').bind(opening.day, to));
  const payouts = await all(env.DB.prepare('SELECT id,day,paid_cents,note,created_by FROM bbj_payouts WHERE day>=? AND day<=? ORDER BY day,id').bind(opening.day, to));
  const events = [...payouts.map((x) => ({ ...x, kind: 'payout' })), ...collects.map((x) => ({ ...x, kind: 'collect' }))]
    .sort((a, b) => a.day.localeCompare(b.day) || (a.kind === 'payout' ? 0 : 1) - (b.kind === 'payout' ? 0 : 1) || (a.id || 0) - (b.id || 0));
  let main = opening.main_cents, reserve = opening.reserve_cents, lastDay = null;
  const t = { amount: 0, taken: 0, pagcor: 0, cdc: 0, everest: 0, pot: 0, main: 0, reserve: 0, paid: 0, days: 0 };
  const rows = [];
  let before = null;
  for (const e of events) {
    if (e.day >= from && before == null) before = { main: p(main), reserve: p(reserve) };
    let row;
    if (e.kind === 'payout') {
      const left = main - e.paid_cents;
      main = reserve + left; reserve = 0;
      row = { kind: 'payout', id: e.id, day: e.day, paid: p(e.paid_cents), note: e.note, by: e.created_by };
      if (e.day >= from) t.paid += e.paid_cents;
    } else {
      const s = splitBbj(e.amount_cents);
      main += s.main; reserve += s.reserve;
      row = { kind: 'collect', day: e.day, amount: p(e.amount_cents), taken: p(s.taken), pagcor: p(s.pagcor), cdc: p(s.cdc), everest: p(s.everest), pot: p(s.pot), to_main: p(s.main), to_reserve: p(s.reserve), by: e.updated_by };
      if (e.day >= from) { t.amount += e.amount_cents; t.taken += s.taken; t.pagcor += s.pagcor; t.cdc += s.cdc; t.everest += s.everest; t.pot += s.pot; t.main += s.main; t.reserve += s.reserve; t.days++; }
    }
    row.main_balance = p(main); row.reserve_balance = p(reserve);
    lastDay = e.day;
    if (e.day >= from) rows.push(row);
  }
  // Like the casino's monthly memo: Pagcor and CDC are worked out on the range's total admin fee, not added up day by day.
  t.pagcor = Math.round(t.taken * 0.25); t.cdc = Math.round(t.taken * 0.05); t.everest = t.taken - t.pagcor - t.cdc;
  for (const k of Object.keys(t)) if (k !== 'days') t[k] = p(t[k]);
  return {
    opening: { day: opening.day, main: p(opening.main_cents), reserve: p(opening.reserve_cents) },
    before: before || { main: p(main), reserve: p(reserve) },
    balance: { main: p(main), reserve: p(reserve), as_of: lastDay || opening.day },
    rows, totals: t
  };
}

// One table over a range of business days: who played, their group when they sat down, playing hours and share, buy-in, and the table's rake.
// Players still at the table count with their time and buy-in so far. One row per player (sessions merged); groups by players, then hours.
async function tableReport(env, url, now, reply, today, from, to) {
  const table = str(url.searchParams.get('table') || '', 10);
  if (!/^[A-Za-z0-9 _-]{1,10}$/.test(table)) return reply({ error: 'Pick a table.' }, 400);
  const after = addDays(to, 1);
  const opens = await dayOpenings(env, from, after);
  const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push({ day: d, start: opens[d], end: opens[addDays(d, 1)] });
  const start = opens[from], end = Math.min(opens[after], now);
  // Table time.
  const runs = await all(env.DB.prepare('SELECT opened_at,closed_at,game_type,blinds FROM table_runs WHERE table_name=? AND opened_at<? AND (closed_at IS NULL OR closed_at>?) ORDER BY opened_at').bind(table, end, start));
  let tableSeconds = 0, first = null, last = null, open = false; const lv = {}, secsByDay = {};
  for (const r of runs) {
    const s0 = Math.max(r.opened_at, start), e0 = Math.min(r.closed_at == null ? now : r.closed_at, end);
    if (e0 <= s0) continue;
    tableSeconds += e0 - s0; first = first == null ? s0 : Math.min(first, s0); last = Math.max(last || 0, e0);
    if (r.closed_at == null) open = true;
    const name = levelOf(r.blinds, r.game_type); lv[name] = (lv[name] || 0) + (e0 - s0);
    for (const d of days) { const a = Math.max(s0, d.start), b = Math.min(e0, d.end); if (b > a) secsByDay[d.day] = (secsByDay[d.day] || 0) + (b - a); }
  }
  // Groups.
  const gname = {};
  for (const g of await all(env.DB.prepare('SELECT g.id,g.name,l.label FROM member_groups g LEFT JOIN group_labels l ON l.group_id=g.id'))) gname[g.id] = { name: g.name, label: g.label || null };
  // Players: finished sessions, then players still seated.
  const people = new Map();
  const person = (key, base) => { if (!people.has(key)) people.set(key, { ...base, seconds: 0, rest_seconds: 0, buy_in: 0, sessions: 0, segments: [], groupSecs: {} }); return people.get(key); };
  const credit = (p, group, secs) => { p.groupSecs[group || ''] = (p.groupSecs[group || ''] || 0) + secs; };
  const rows = await all(env.DB.prepare(`SELECT ps.member_id,ps.member_ref,ps.group_id,ps.seat,ps.start_at,ps.end_at,ps.active_seconds,ps.rest_seconds,ps.buy_in,m.member_no,m.nickname,m.surname,m.middle_name,m.family_name
    FROM play_sessions ps LEFT JOIN members m ON m.id=ps.member_id WHERE ps.table_name=? AND ps.start_at>=? AND ps.start_at<? ORDER BY ps.start_at`).bind(table, start, end));
  const sessions = [];
  for (const r of rows) {
    const p = person(r.member_id ? 'm' + r.member_id : 'r' + r.member_ref.toLowerCase(), { member_no: r.member_no || null, nickname: r.member_id ? r.nickname || '' : r.member_ref, name: r.member_id ? displayName(r) : '', matched: !!r.member_id });
    p.seconds += r.active_seconds; p.rest_seconds += r.rest_seconds; p.buy_in += r.buy_in || 0; p.sessions++; credit(p, r.group_id, r.active_seconds);
    p.segments.push({ seat: r.seat, start: r.start_at, end: r.end_at, live: false });
    sessions.push({ group: r.group_id || '', key: p, secs: r.active_seconds, buy: r.buy_in || 0 });
  }
  const live = to === today ? (await liveSeats(env)).filter((x) => x.table === table && x.started != null && x.started >= start && x.started < end) : [];
  const liveIds = [...new Set(live.filter((x) => x.member_id).map((x) => x.member_id))];
  const cur = {};
  for (let i = 0; i < liveIds.length; i += 45) {
    const chunk = liveIds.slice(i, i + 45);
    for (const m of await all(env.DB.prepare(`SELECT id,member_no,nickname,surname,middle_name,family_name,group_id FROM members WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk))) cur[m.id] = m;
  }
  for (const x of live) {
    const m = x.member_id ? cur[x.member_id] : null;
    const p = person(m ? 'm' + m.id : 'r' + String(x.ref).toLowerCase(), { member_no: m ? m.member_no : null, nickname: m ? m.nickname || '' : x.ref, name: m ? displayName(m) : '', matched: !!m });
    p.seconds += x.active_seconds; p.rest_seconds += x.rest_seconds; p.buy_in += x.buy_in || 0; p.sessions++; credit(p, m ? m.group_id : null, x.active_seconds);
    p.segments.push({ seat: x.seat, start: x.started, end: null, live: true });
    sessions.push({ group: (m && m.group_id) || '', key: p, secs: x.active_seconds, buy: x.buy_in || 0 });
  }
  const total = [...people.values()].reduce((a, p) => a + p.seconds, 0);
  const players = [...people.values()].map((p) => {
    const gs = Object.entries(p.groupSecs).sort((a, b) => b[1] - a[1]).map(([g]) => g);
    return { member_no: p.member_no, nickname: p.nickname, name: p.name, matched: p.matched, seconds: p.seconds, rest_seconds: p.rest_seconds, buy_in: p.buy_in, sessions: p.sessions,
      share: total ? p.seconds / total : 0, groups: gs.map((g) => (g ? (gname[g] || { name: g }).name : 'No group')), playing_now: p.segments.some((g) => g.live),
      segments: p.segments.sort((a, b) => a.start - b.start) };
  }).sort((a, b) => b.seconds - a.seconds || a.nickname.localeCompare(b.nickname));
  const gmap = {};
  for (const x of sessions) { const g = (gmap[x.group] ||= { id: x.group, name: x.group ? (gname[x.group] || { name: x.group }).name : 'No group', label: x.group && gname[x.group] ? gname[x.group].label : null, who: new Set(), seconds: 0, buy_in: 0 }); g.who.add(x.key); g.seconds += x.secs; g.buy_in += x.buy; }
  const groups = Object.values(gmap).map((g) => ({ id: g.id, name: g.name, label: g.label, players: g.who.size, seconds: g.seconds, buy_in: g.buy_in, share: total ? g.seconds / total : 0 }))
    .sort((a, b) => b.players - a.players || b.seconds - a.seconds);
  // Rake entered for this table; per table hour only over days that have it.
  let rake = 0, rakeDays = 0, rakeSecs = 0;
  for (const e of await all(env.DB.prepare('SELECT day,revenue FROM table_revenue WHERE table_name=? AND day>=? AND day<=?').bind(table, from, to))) { rake += e.revenue; rakeDays++; rakeSecs += secsByDay[e.day] || 0; }
  return reply({ table, from, to, today, as_of: now, still_open: open, first_open: first, last_close: open ? null : last,
    table_seconds: tableSeconds, days_open: Object.keys(secsByDay).length, levels: Object.entries(lv).sort((a, b) => b[1] - a[1]).map(([name, seconds]) => ({ name, seconds })),
    totals: { players: players.length, sessions: sessions.length, seconds: total, buy_in: players.reduce((a, p) => a + p.buy_in, 0), playing_now: live.length },
    groups, players, rake: rakeDays ? { amount: rake, days: rakeDays, per_hour: rakeSecs ? rake / (rakeSecs / 3600) : null } : null });
}
