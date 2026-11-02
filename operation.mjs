// Daily operation: business day, live tables, hours, visitors, buy-in and cash-out.
// Business day D starts at 12:00 Manila, or earlier if a table opened (or a session started) between 06:00 and 12:00 that day.
// It ends when business day D+1 starts. Sessions belong to the business day in which they started.
import { str, localDate, dayStart, ppmTime, normNo, liveSeatPlayers } from './members.mjs';

const HOUR = 3600, DAY = 86400;
const all = async (stmt) => (await stmt.all()).results || [];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const addDays = (d, n) => localDate(dayStart(d) + n * DAY + HOUR);

// Track when each PPM table is running. Called after every PPM save; a run opens when a table starts or resumes
// (at PPM's own start time) and closes at the save that stops or pauses it.
export async function recordTableRuns(env, tables, now) {
  const openRows = await all(env.DB.prepare('SELECT run_key,table_name,game_type,blinds FROM table_runs WHERE closed_at IS NULL'));
  const open = new Map(openRows.map((r) => [r.table_name, r.run_key]));
  const openLevel = new Map(openRows.map((r) => [r.table_name, r.blinds + '|' + r.game_type]));
  const stmts = [];
  for (const t of tables || []) {
    const name = str(t.name || 'T' + t.id, 10);
    const running = t.isRunning === true;
    // Level changed while running: close the run and start a new one, so table hours are split by level.
    if (running && open.has(name) && openLevel.get(name) !== str(t.blinds, 20) + '|' + str(t.gameType, 10)) {
      stmts.push(env.DB.prepare('UPDATE table_runs SET closed_at=? WHERE run_key=? AND closed_at IS NULL').bind(now, open.get(name)));
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO table_runs(run_key,table_name,opened_at,closed_at,game_type,blinds) VALUES(?,?,?,NULL,?,?)')
        .bind(`${name}|${now}`, name, now, str(t.gameType, 10), str(t.blinds, 20)));
    } else if (running && !open.has(name)) {
      const started = Number.isFinite(t.lastStartTime) ? Math.min(now, Math.floor(t.lastStartTime / 1000)) : now;
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO table_runs(run_key,table_name,opened_at,closed_at,game_type,blinds) VALUES(?,?,?,NULL,?,?)')
        .bind(`${name}|${started}`, name, started, str(t.gameType, 10), str(t.blinds, 20)));
    } else if (!running && open.has(name)) {
      stmts.push(env.DB.prepare('UPDATE table_runs SET closed_at=? WHERE run_key=? AND closed_at IS NULL').bind(now, open.get(name)));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
}

async function dayOpensAt(env, d) {
  const base = dayStart(d), noon = base + 12 * HOUR, early = base + 6 * HOUR;
  const run = await env.DB.prepare('SELECT MIN(opened_at) t FROM table_runs WHERE opened_at>=? AND opened_at<?').bind(early, noon).first();
  const ses = await env.DB.prepare('SELECT MIN(start_at) t FROM play_sessions WHERE start_at>=? AND start_at<?').bind(early, noon).first();
  const times = [run && run.t, ses && ses.t].filter((x) => x != null);
  return times.length ? Math.min(...times) : noon;
}
export async function businessDay(env, now, wanted) {
  let d = isDate(wanted) ? wanted : localDate(now);
  let start = await dayOpensAt(env, d);
  if (!isDate(wanted) && now < start) { d = addDays(d, -1); start = await dayOpensAt(env, d); }
  const end = await dayOpensAt(env, addDays(d, 1));
  return { day: d, start, end, is_today: now >= start && now < end };
}

export async function handleOperation(req, env, now, reply, role) {
  if (role === 'staff') return reply({ error: 'Manager only.' }, 403);
  const url = new URL(req.url);
  const bd = await businessDay(env, now, url.searchParams.get('day'));
  const until = Math.min(now, bd.end);

  // Live tables (only meaningful for today).
  const ppmRow = await env.DB.prepare('SELECT data FROM ppm WHERE id=1').first();
  const room = await env.DB.prepare('SELECT data FROM room WHERE id=1').first();
  const queue = room ? (JSON.parse(room.data).queue || []) : [];
  const tables = [];
  let liveBuyIn = 0, livePlayers = 0, liveSeconds = 0;
  const liveRefs = new Set();
  for (const t of ppmRow ? JSON.parse(ppmRow.data) : []) {
    const seats = t.seats || [];
    const seated = seats.filter((s) => s.status === 'seated').length, resting = seats.filter((s) => s.status === 'rest').length;
    let elapsed = Math.max(0, Number(t.elapsedSeconds) || 0);
    if (t.isRunning && Number.isFinite(t.lastStartTime)) elapsed += Math.max(0, (Date.now() - t.lastStartTime) / 1000);
    const game = `${t.blinds || ''} ${t.gameType || ''}`.trim();
    const buyIn = seats.filter((s) => s.status !== 'idle').reduce((a, s) => a + (Number.isSafeInteger(s.buyInAmount) ? s.buyInAmount : 0), 0);
    const players = seats.filter((s) => s.status !== 'idle');
    for (const s of players) {
      const raw = str(s.memberId, 60).toLowerCase(), no = normNo(raw).toLowerCase();
      liveRefs.add(/^ev-\d{6}$/.test(no) ? no : raw);
      let a = Math.max(0, Number(s.activeSeconds) || 0);
      if (s.status === 'seated' && s.lastActiveStart) a += Math.max(0, (Date.now() - s.lastActiveStart) / 1000);
      liveSeconds += a;
    }
    if (bd.is_today) { liveBuyIn += buyIn; livePlayers += players.length; }
    tables.push({ name: t.name || 'T' + t.id, running: !!t.isRunning, game_type: t.gameType || '', blinds: t.blinds || '', seated, resting, empty: 9 - seated - resting,
      opened_at: t.isRunning && t.openedAt ? ppmTime(t.openedAt) : null, run_seconds: Math.round(elapsed), buy_in_on_table: buyIn, waiting: queue.filter((q) => q.game === game).length });
  }

  // Who is sitting where right now, with their member profile.
  if (bd.is_today) {
    const players = await liveSeatPlayers(env);
    for (const t of tables) t.players = players.filter((p) => p.table === t.name).sort((a, b) => a.seat - b.seat);
  }
  const bbjRow = await env.DB.prepare('SELECT day,main_cents,reserve_cents FROM bbj_daily WHERE day<=? AND (main_cents IS NOT NULL OR reserve_cents IS NOT NULL) ORDER BY day DESC LIMIT 1').bind(bd.day).first();
  const bbj = bbjRow ? { day: bbjRow.day, main: bbjRow.main_cents == null ? null : bbjRow.main_cents / 100, reserve: bbjRow.reserve_cents == null ? null : bbjRow.reserve_cents / 100 } : null;

  // Finished sessions that started in this business day.
  const fin = await env.DB.prepare(`SELECT COUNT(*) sessions, COALESCE(SUM(ps.active_seconds),0) secs, COALESCE(SUM(ps.rest_seconds),0) rest_secs, COALESCE(SUM(ps.buy_in),0) buy_in,
      COUNT(sr.session_id) with_cash_out, COALESCE(SUM(sr.cash_out),0) cash_out, COALESCE(SUM(CASE WHEN sr.session_id IS NULL AND ps.buy_in IS NOT NULL THEN 1 ELSE 0 END),0) missing_cash_out,
      COALESCE(SUM(CASE WHEN sr.session_id IS NULL THEN ps.buy_in ELSE 0 END),0) buy_in_without_cash_out, COALESCE(SUM(sr.busted),0) busted
    FROM play_sessions ps LEFT JOIN session_results sr ON sr.session_id=ps.id WHERE ps.start_at>=? AND ps.start_at<?`).bind(bd.start, bd.end).first();
  // Visitors: distinct members, plus distinct unmatched PPM names, plus people at a table now who have not left yet.
  const vis = await all(env.DB.prepare(`SELECT DISTINCT COALESCE('m' || m.member_no, 'r' || lower(ps.member_ref)) who, m.member_no, lower(ps.member_ref) ref
    FROM play_sessions ps LEFT JOIN members m ON m.id=ps.member_id WHERE ps.start_at>=? AND ps.start_at<?`).bind(bd.start, bd.end));
  const visitors = new Set(vis.map((v) => v.who));
  const finishedRefs = new Set(vis.flatMap((v) => [v.ref, v.member_no ? v.member_no.toLowerCase() : null]).filter(Boolean));
  let liveNew = 0;
  if (bd.is_today) for (const r of liveRefs) if (!finishedRefs.has(r)) liveNew++;
  const matched = vis.filter((v) => v.member_no).length;
  const newMembers = await env.DB.prepare('SELECT COUNT(*) n FROM members WHERE created_at>=? AND created_at<?').bind(bd.start, bd.end).first();

  // Table hours: time tables were running inside the business day.
  const runs = await all(env.DB.prepare('SELECT table_name,opened_at,closed_at FROM table_runs WHERE opened_at<? AND (closed_at IS NULL OR closed_at>?)').bind(bd.end, bd.start));
  let tableSeconds = 0;
  const perTable = {};
  for (const r of runs) {
    const s = Math.max(r.opened_at, bd.start), e = Math.min(r.closed_at == null ? until : r.closed_at, bd.end, until);
    if (e > s) { tableSeconds += e - s; perTable[r.table_name] = (perTable[r.table_name] || 0) + (e - s); }
  }
  const firstOpen = runs.length ? Math.max(bd.start, Math.min(...runs.map((r) => r.opened_at))) : null;
  const lastClose = runs.length && runs.every((r) => r.closed_at != null) ? Math.min(bd.end, Math.max(...runs.map((r) => r.closed_at))) : null;

  // Recent days for comparison.
  const history = [];
  for (let i = 1; i <= 7; i++) {
    const d = addDays(bd.day, -i);
    const s = await dayOpensAt(env, d), e = await dayOpensAt(env, addDays(d, 1));
    const h = await env.DB.prepare(`SELECT COUNT(DISTINCT COALESCE('m' || ps.member_id, 'r' || lower(ps.member_ref))) visitors, COALESCE(SUM(ps.active_seconds),0) secs, COALESCE(SUM(ps.buy_in),0) buy_in, COALESCE(SUM(sr.cash_out),0) cash_out
      FROM play_sessions ps LEFT JOIN session_results sr ON sr.session_id=ps.id WHERE ps.start_at>=? AND ps.start_at<?`).bind(s, e).first();
    history.push({ day: d, ...h });
  }

  return reply({
    day: bd.day, start: bd.start, end: bd.end, is_today: bd.is_today, now, bbj,
    open_tables: tables.filter((t) => t.running).length, tables: bd.is_today ? tables : [],
    operating: { since: firstOpen, until: lastClose, seconds: firstOpen ? Math.max(0, (lastClose || until) - firstOpen) : 0, table_seconds: tableSeconds, per_table: perTable },
    play: { finished_seconds: fin.secs, live_seconds: bd.is_today ? Math.round(liveSeconds) : 0, rest_seconds: fin.rest_secs, sessions: fin.sessions },
    visitors: { total: visitors.size + liveNew, members: matched, unmatched: visitors.size - matched, at_table_now: bd.is_today ? livePlayers : 0, new_members: newMembers.n },
    money: { buy_in_finished: fin.buy_in, buy_in_live: liveBuyIn, buy_in_total: fin.buy_in + liveBuyIn, cash_out: fin.cash_out, sessions_with_cash_out: fin.with_cash_out,
      missing_cash_out: fin.missing_cash_out, buy_in_without_cash_out: fin.buy_in_without_cash_out, busted: fin.busted },
    history
  });
}
