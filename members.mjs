// Everest member system — staff API (phase 1).
// Members, player groups, group history, PPM play time and rewards.
// All routes here run after the staff session check in worker.mjs, except /register.

const TZ_OFFSET = 8 * 3600; // Philippines, UTC+8. PPM writes local wall-clock times.
const DAY = 86400;
const REWARD_TYPES = ['free_chip', 'promo_cash', 'promo_chip', 'hotel', 'transportation', 'tournament_ticket'];
const STATUSES = ['active', 'suspended', 'banned'];
const PROFILE_FIELDS = ['surname', 'middle_name', 'family_name', 'nickname', 'nationality', 'birthday', 'passport_id',
  'email', 'phone', 'whatsapp', 'telegram', 'line', 'referral_id', 'language'];
const LIMITS = { surname: 80, middle_name: 80, family_name: 80, nickname: 60, nationality: 60, birthday: 10, passport_id: 40,
  email: 120, phone: 40, whatsapp: 40, telegram: 60, line: 60, referral_id: 60, language: 20 };

// ---------- small helpers ----------
export const str = (v, max = 200) => (typeof v === 'string' || typeof v === 'number') ? String(v).trim().slice(0, max) : '';
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
// 'YYYY-MM-DD' (Manila) -> unix seconds at local midnight
export const dayStart = (s) => Math.floor(Date.parse(s + 'T00:00:00Z') / 1000) - TZ_OFFSET;
// unix seconds -> 'YYYY-MM-DD' in Manila
export const localDate = (t) => new Date((t + TZ_OFFSET) * 1000).toISOString().slice(0, 10);
// PPM 'YYYY-MM-DD HH:MM:SS' (Manila wall clock) -> unix seconds
export function ppmTime(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return null;
  const ms = Date.parse(text.replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000) - TZ_OFFSET;
}
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const marks = (n) => Array(n).fill('?').join(',');
const all = async (stmt) => (await stmt.all()).results || [];
// A photo is a data URL of a small image; the console resizes to 320×320 JPEG (~30 KB) before sending.
export const PHOTO_MAX = 600000;
export const validPhoto = (d) => typeof d === 'string' && d.length <= PHOTO_MAX && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(d);
function ageOn(birthday, now) {
  if (!isDate(birthday)) return null;
  const [y, m, d] = birthday.split('-').map(Number);
  const today = new Date((now + TZ_OFFSET) * 1000);
  let age = today.getUTCFullYear() - y;
  if (today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d)) age--;
  return age;
}
function displayName(m) {
  return [m.surname, m.middle_name, m.family_name].filter(Boolean).join(' ') || m.nickname || m.member_no;
}
function publicMember(m, groups) {
  const g = m.group_id ? groups.get(m.group_id) : null;
  return {
    member_no: m.member_no, name: displayName(m), surname: m.surname, middle_name: m.middle_name, family_name: m.family_name,
    nickname: m.nickname, nationality: m.nationality, birthday: m.birthday,
    passport_last4: m.passport_id ? m.passport_id.slice(-4) : '',
    email: m.email, phone: m.phone, whatsapp: m.whatsapp, telegram: m.telegram, line: m.line,
    referral_id: m.referral_id, language: m.language, status: m.status, staff_notes: m.staff_notes,
    group_id: m.group_id, group_name: g ? g.name : null, group_owner: g ? g.owner : null,
    source: m.source, created_at: m.created_at, updated_at: m.updated_at, has_photo: !!m.has_photo
  };
}
const audit = (env, now, actor, action, memberId, detail) =>
  env.DB.prepare('INSERT INTO audit_log(at,actor,action,member_id,detail) VALUES(?,?,?,?,?)')
    .bind(now, str(actor, 60), action, memberId ?? null, str(detail, 500));

async function loadGroups(env) {
  const rows = await all(env.DB.prepare('SELECT id,name,kind,owner,sort,active FROM member_groups ORDER BY sort,name'));
  return new Map(rows.map((g) => [g.id, g]));
}
// Staff type just the six digits: 444444 or ev444444 → EV-444444. Anything else (e.g. VIP-007) is kept as typed.
export function normNo(v) {
  const s = str(v, 30).toUpperCase();
  const m = /^(?:EV-?)?(\d{1,6})$/.exec(s);
  return m ? 'EV-' + m[1].padStart(6, '0') : s;
}
async function memberByNo(env, no) {
  return env.DB.prepare('SELECT * FROM members WHERE member_no=? COLLATE NOCASE').bind(normNo(no)).first();
}
async function memberByOldNo(env, no) {
  return env.DB.prepare('SELECT m.* FROM member_number_history h JOIN members m ON m.id=h.member_id WHERE h.old_no=? COLLATE NOCASE').bind(normNo(no)).first();
}
async function nextMemberNumber(env) {
  const row = await env.DB.prepare("SELECT MAX(n) AS n FROM (SELECT CAST(SUBSTR(member_no,4) AS INTEGER) n FROM members WHERE member_no LIKE 'EV-%' UNION ALL SELECT CAST(SUBSTR(old_no,4) AS INTEGER) FROM member_number_history WHERE old_no LIKE 'EV-%')").first();
  return (row && row.n ? row.n : 0) + 1;
}
const formatNo = (n) => 'EV-' + String(n).padStart(6, '0');

// Group in force for a member at a given time, from history rows sorted by effective_from.
// Before a member's first assignment, play counts for that first group (the player was already that host's guest).
// Later changes only move hours from the change onward.
function groupAtFrom(history, memberId, t) {
  let g, first;
  for (const h of history) {
    if (h.member_id !== memberId) continue;
    if (first === undefined) first = h.group_id;
    if (h.effective_from <= t) g = h.group_id;
  }
  return g !== undefined ? g : (first !== undefined ? first : null);
}
async function groupAt(env, memberId, t) {
  const history = await all(env.DB.prepare('SELECT member_id,group_id,effective_from FROM member_group_history WHERE member_id=? ORDER BY effective_from, id').bind(memberId));
  return groupAtFrom(history, memberId, t);
}

// Match names typed in PPM to members: member number (or six digits), an old number, then a nickname used by only one member.
async function matchRefs(env, list) {
  const refs = [...new Set(list.flatMap((r) => [r.toLowerCase(), normNo(r).toLowerCase()]))];
  const byNo = new Map(), byNick = new Map();
  for (const part of chunks(refs, 45)) {
    const rows = await all(env.DB.prepare(`SELECT id,member_no,nickname FROM members WHERE lower(member_no) IN (${marks(part.length)}) OR lower(nickname) IN (${marks(part.length)})`).bind(...part, ...part));
    for (const r of rows) {
      byNo.set(r.member_no.toLowerCase(), r.id);
      if (r.nickname) { const k = r.nickname.toLowerCase(); byNick.set(k, byNick.has(k) && byNick.get(k) !== r.id ? -1 : r.id); }
    }
  }
  for (const part of chunks(refs, 90)) {
    const rows = await all(env.DB.prepare(`SELECT old_no,member_id FROM member_number_history WHERE lower(old_no) IN (${marks(part.length)})`).bind(...part));
    for (const r of rows) if (!byNo.has(r.old_no.toLowerCase())) byNo.set(r.old_no.toLowerCase(), r.member_id);
  }
  return (ref) => { const k = ref.toLowerCase(), n6 = normNo(ref).toLowerCase(); if (byNo.has(k)) return byNo.get(k); if (byNo.has(n6)) return byNo.get(n6); const n = byNick.get(k); return n && n > 0 ? n : null; };
}
const seatKey = (tableName, seatId, ref, start) => [tableName, seatId, ref, start].join('|').slice(0, 200);
async function seatLinks(env, keys) {
  const map = new Map();
  for (const part of chunks([...new Set(keys)], 90)) {
    if (!part.length) continue;
    (await all(env.DB.prepare(`SELECT seat_key,member_id FROM ppm_seat_links WHERE seat_key IN (${marks(part.length)})`).bind(...part))).forEach((r) => map.set(r.seat_key, r.member_id));
  }
  return map;
}

// Players sitting in PPM right now, with the member each one counts for (by typed number/nickname or a seat link).
async function liveSeats(env) {
  const ppmRow = await env.DB.prepare('SELECT data FROM ppm WHERE id=1').first();
  const live = [];
  for (const t of ppmRow ? JSON.parse(ppmRow.data) : []) {
    for (const seat of t.seats || []) {
      const ref = str(seat.memberId, 60);
      if (!ref || seat.status === 'idle' || !seat.sessionStart) continue;
      let active = Math.max(0, Number(seat.activeSeconds) || 0);
      if (seat.status === 'seated' && seat.lastActiveStart) active += Math.max(0, (Date.now() - seat.lastActiveStart) / 1000);
      live.push({ table: t.name || 'T' + t.id, seat: seat.id, ref, status: seat.status, started: ppmTime(seat.sessionStart), active_seconds: Math.round(active), key: seatKey(t.name || t.id, seat.id, ref, seat.sessionStart) });
    }
  }
  const matched = await matchRefs(env, live.map((x) => x.ref));
  const links = await seatLinks(env, live.map((x) => x.key));
  for (const x of live) { x.auto_member = matched(x.ref); x.link_member = links.get(x.key) || null; x.member_id = x.link_member || x.auto_member; } // a staff link overrides the automatic match
  return live;
}
// Does the name typed in PPM look like this member? Used to ask "are you sure?" before linking.
function nameFits(ref, m) {
  const r = ref.toLowerCase().replace(/\s+/g, ' ').trim();
  const names = [m.nickname, m.surname, m.family_name, m.middle_name, displayName(m), [m.family_name, m.surname].filter(Boolean).join(' '), m.member_no]
    .filter(Boolean).map((v) => v.toLowerCase().replace(/\s+/g, ' ').trim());
  return names.some((n) => n === r || (r.length >= 3 && (n.split(' ').includes(r) || r.split(' ').includes(n))));
}

// ---------- PPM -> play_sessions ----------
// Called after every successful PPM save. Only sessions not seen before are written, so it is cheap and repeatable.
export async function ingestPpm(env, tables, now = Math.floor(Date.now() / 1000)) {
  const found = [];
  for (const t of tables || []) {
    for (const s of Array.isArray(t.sessions) ? t.sessions : []) {
      const ref = str(s && s.memberId, 60);
      const start = ppmTime(s && s.startTime), end = ppmTime(s && s.endTime);
      if (!ref || start === null || end === null) continue;
      const key = [t.name || t.id, s.seatId, ref, s.startTime, s.endTime].join('|').slice(0, 200);
      found.push({ key, ref, start, end, s, t });
    }
  }
  if (!found.length) return { inserted: 0 };
  const seen = new Set();
  for (const part of chunks(found.map((f) => f.key), 90)) {
    const rows = await all(env.DB.prepare(`SELECT session_key FROM play_sessions WHERE session_key IN (${marks(part.length)})`).bind(...part));
    rows.forEach((r) => seen.add(r.session_key));
  }
  const fresh = [];
  for (const f of found) { if (!seen.has(f.key)) { seen.add(f.key); fresh.push(f); } }
  fresh.splice(400);
  if (!fresh.length) return { inserted: 0 };

  const matched = await matchRefs(env, fresh.map((f) => f.ref));
  const linked = await seatLinks(env, fresh.map((f) => seatKey(f.t.name || f.t.id, f.s.seatId, f.ref, f.s.startTime)));
  const memberOf = (ref, f) => (f && linked.get(seatKey(f.t.name || f.t.id, f.s.seatId, f.ref, f.s.startTime))) || matched(ref);
  const ids = [...new Set(fresh.map((f) => memberOf(f.ref, f)).filter(Boolean))];
  let history = [];
  for (const part of chunks(ids, 90)) {
    history = history.concat(await all(env.DB.prepare(`SELECT member_id,group_id,effective_from FROM member_group_history WHERE member_id IN (${marks(part.length)}) ORDER BY effective_from, id`).bind(...part)));
  }
  history.sort((a, b) => a.effective_from - b.effective_from);

  const stmts = fresh.map((f) => {
    const memberId = memberOf(f.ref, f);
    const groupId = memberId ? groupAtFrom(history, memberId, f.start) : null; // group at seat-in time
    const active = Math.max(0, Math.floor(Number(f.s.activeSeconds) || 0));
    const rest = Math.max(0, Math.floor(Number(f.s.restSeconds) || 0));
    const buyIn = Number.isSafeInteger(f.s.buyInAmount) && f.s.buyInAmount >= 0 ? f.s.buyInAmount : null;
    return env.DB.prepare(`INSERT OR IGNORE INTO play_sessions(session_key,member_id,member_ref,group_id,play_date,table_name,seat,game_type,blinds,start_at,end_at,active_seconds,rest_seconds,buy_in,transfer_note,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(f.key, memberId, f.ref, groupId, localDate(f.start), str(f.t.name, 10), Number(f.s.seatId) || 0,
      str(f.t.gameType, 10), str(f.t.blinds, 20), f.start, f.end, active, rest, buyIn, f.s.transferNote ? str(f.s.transferNote, 120) : null, now);
  });
  if (linked.size) stmts.push(env.DB.prepare('DELETE FROM ppm_seat_links WHERE created_at<?').bind(now - 3 * DAY));
  for (const part of chunks(stmts, 50)) await env.DB.batch(part);
  return { inserted: fresh.length };
}

// ---------- request handling ----------
async function readJson(req, max = 200000) {
  const text = await req.text();
  if (text.length > max) { const e = new Error('Too large'); e.status = 413; throw e; }
  return text ? JSON.parse(text) : {};
}
const bad = (reply, msg, status = 400) => reply({ error: msg }, status);
function range(url, now) {
  const to = url.searchParams.get('to'), from = url.searchParams.get('from');
  const end = to && isDate(to) ? dayStart(to) + DAY : dayStart(localDate(now)) + DAY;
  const start = from && isDate(from) ? dayStart(from) : end - 30 * DAY;
  return { start, end, from: localDate(start), to: localDate(end - 1) };
}

export const isMemberApi = (path) => /^\/(members|groups|rewards|sessions)(\/|$)/.test(path) || path === '/ppm/sync';

// Public self-registration (replaces the Google Sheet form). Rate limited per IP.
export async function handleRegister(req, env, now, reply, ipHash) {
  const attempt = await env.DB.prepare('INSERT INTO register_attempts(ip,started,count) VALUES(?,?,1) ON CONFLICT(ip) DO UPDATE SET count=CASE WHEN started<? THEN 1 ELSE count+1 END,started=CASE WHEN started<? THEN ? ELSE started END RETURNING count')
    .bind(ipHash, now, now - 3600, now - 3600, now).first();
  if (attempt.count > 5) return bad(reply, 'Too many registrations. Try again later.', 429);
  const b = await readJson(req, 5000);
  if (!b.agreedTerms || !b.agreedAge || !b.agreedPolicy) return bad(reply, 'Please accept the terms.');
  const m = {
    surname: str(b.surname, 80), middle_name: str(b.middleName, 80), family_name: str(b.familyName, 80), nickname: str(b.nickName, 60),
    nationality: str(b.nationality, 60), birthday: str(b.birthday, 10), passport_id: str(b.passportId, 40), email: str(b.email, 120),
    phone: str(b.phone, 40), whatsapp: str(b.whatsapp, 40), telegram: str(b.telegram, 60), line: str(b.line, 60),
    referral_id: str(b.referralId, 60), language: str(b.language, 20)
  };
  if (!m.surname && !m.family_name) return bad(reply, 'Name is required.');
  const age = ageOn(m.birthday, now);
  if (age === null) return bad(reply, 'Birthday is required.');
  if (age < 21) return bad(reply, 'Members must be 21 or older.');
  const created = await createMember(env, now, m, null, 'register-form', 'register-form');
  return reply({ ok: true, member_no: created.member_no });
}

async function createMember(env, now, fields, groupId, source, actor, wantedNo) {
  let n = wantedNo ? null : await nextMemberNumber(env);
  for (let tries = 0; tries < 5; tries++) {
    const no = wantedNo || formatNo(n + tries);
    const cols = PROFILE_FIELDS.filter((k) => fields[k]);
    try {
      const results = await env.DB.batch([
        env.DB.prepare(`INSERT INTO members(member_no,${cols.concat(['group_id', 'source', 'created_at', 'updated_at']).join(',')}) VALUES(?,${marks(cols.length + 4)})`)
          .bind(no, ...cols.map((k) => fields[k]), groupId, source, now, now),
        ...(groupId ? [env.DB.prepare('INSERT INTO member_group_history(member_id,group_id,effective_from,changed_by,note,created_at) SELECT id,?,?,?,?,? FROM members WHERE member_no=?')
          .bind(groupId, now, str(actor, 60), 'Initial group', now, no)] : []),
        env.DB.prepare("INSERT INTO audit_log(at,actor,action,member_id,detail) SELECT ?,?,'member.create',id,? FROM members WHERE member_no=?").bind(now, str(actor, 60), source, no)
      ]);
      return { member_no: no, results };
    } catch (e) {
      if (wantedNo || !/UNIQUE/i.test(String(e && e.message))) throw e;
    }
  }
  throw new Error('Could not allocate a member number');
}

// One spelling per country, so reports never split "Taiwan" and "Taiwanese".
export const NATIONALITIES = ['Taiwan', 'Philippines', 'South Korea', 'Japan', 'Hong Kong', 'Macau', 'China', 'Singapore', 'Thailand', 'Indonesia', 'Malaysia', 'Vietnam', 'India', 'United States', 'Canada', 'Australia', 'United Kingdom'];
const NAT_ALIASES = {
  'Taiwan': ['taiwan', 'taiwanese', 'tw', 'twn', 'roc', 'republic of china', 'taiwan roc', '台灣', '臺灣', '中華民國', '台湾'],
  'Philippines': ['philippines', 'philippine', 'filipino', 'filipina', 'ph', 'phl', 'pilipinas', '菲律賓', '菲律宾'],
  'South Korea': ['south korea', 'korea', 'korean', 'republic of korea', 'rok', 'kr', 'kor', '韓國', '韩国', '대한민국', '한국'],
  'Japan': ['japan', 'japanese', 'jp', 'jpn', '日本'],
  'Hong Kong': ['hong kong', 'hongkong', 'hk', 'hkg', 'hong kong sar', '香港'],
  'Macau': ['macau', 'macao', 'mo', 'mac', '澳門', '澳门'],
  'China': ['china', 'chinese', 'prc', 'cn', 'chn', "people's republic of china", 'mainland china', '中國', '中国', '大陸', '大陆'],
  'Singapore': ['singapore', 'singaporean', 'sg', 'sgp', '新加坡'],
  'Thailand': ['thailand', 'thai', 'th', 'tha', '泰國', '泰国'],
  'Indonesia': ['indonesia', 'indonesian', 'id', 'idn', '印尼', '印度尼西亞', '印度尼西亚'],
  'Malaysia': ['malaysia', 'malaysian', 'my', 'mys', '馬來西亞', '马来西亚'],
  'Vietnam': ['vietnam', 'viet nam', 'vietnamese', 'vn', 'vnm', '越南'],
  'India': ['india', 'indian', 'in', 'ind', '印度'],
  'United States': ['united states', 'united states of america', 'usa', 'us', 'u.s.', 'u.s.a.', 'america', 'american', '美國', '美国'],
  'Canada': ['canada', 'canadian', 'ca', 'can', '加拿大'],
  'Australia': ['australia', 'australian', 'au', 'aus', '澳洲', '澳大利亞', '澳大利亚'],
  'United Kingdom': ['united kingdom', 'uk', 'u.k.', 'gb', 'gbr', 'great britain', 'britain', 'british', 'england', 'english', '英國', '英国']
};
const NAT_LOOKUP = new Map(Object.entries(NAT_ALIASES).flatMap(([name, list]) => list.map((a) => [a, name])));
export function normNationality(v) {
  const s = str(v, 60);
  return NAT_LOOKUP.get(s.toLowerCase().replace(/\s+/g, ' ').trim()) || s;
}
function pickFields(b) {
  const out = {};
  for (const k of PROFILE_FIELDS) if (k in b) out[k] = str(b[k], LIMITS[k]);
  if ('nationality' in out) out.nationality = normNationality(out.nationality);
  return out;
}

export async function handleMembersApi(req, env, path, now, reply, user, role = 'admin') {
  // master (set in wrangler.toml MASTER_USERS) > admin (manager) > staff.
  const manager = role !== 'staff';
  const master = role === 'master';
  const managerOnly = () => bad(reply, 'Manager only.', 403);
  const masterOnly = () => bad(reply, 'Only the master account can do this.', 403);
  // The signed-in staff account is the actor in every log entry; the typed name is only a fallback for old sessions.
  const who = (b) => str(user, 60) || str(b && b.staff, 60);
  const url = new URL(req.url);
  const method = req.method;
  const groups = await loadGroups(env);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);

  // ----- PPM back-fill -----
  if (path === '/ppm/sync' && method === 'POST') {
    const row = await env.DB.prepare('SELECT data FROM ppm WHERE id=1').first();
    return reply(await ingestPpm(env, row ? JSON.parse(row.data) : [], now));
  }

  // ----- groups -----
  if (parts[0] === 'groups' && parts.length === 1 && method === 'GET') {
    const counts = await all(env.DB.prepare("SELECT group_id,COUNT(*) n FROM members WHERE status='active' GROUP BY group_id"));
    const byGroup = new Map(counts.map((c) => [c.group_id, c.n]));
    return reply({ groups: [...groups.values()].map((g) => ({ ...g, members: byGroup.get(g.id) || 0 })), unassigned: byGroup.get(null) || 0 });
  }
  if (parts[0] === 'groups' && parts[1] === 'summary' && method === 'GET') {
    const r = range(url, now);
    const play = await all(env.DB.prepare(`SELECT ps.group_id, ps.member_id, SUM(ps.active_seconds) secs, COUNT(*) sessions, COUNT(DISTINCT ps.play_date) days, MAX(ps.start_at) last,
        m.member_no, m.surname, m.middle_name, m.family_name, m.nickname, m.group_id AS current_group
      FROM play_sessions ps JOIN members m ON m.id=ps.member_id
      WHERE ps.start_at>=? AND ps.start_at<? GROUP BY ps.group_id, ps.member_id`).bind(r.start, r.end));
    const rw = await all(env.DB.prepare(`SELECT rw.group_id, rw.member_id, SUM(rw.amount) amt, m.member_no, m.surname, m.middle_name, m.family_name, m.nickname, m.group_id AS current_group
      FROM rewards rw JOIN members m ON m.id=rw.member_id
      WHERE rw.voided=0 AND rw.approved_at IS NOT NULL AND rw.given_at>=? AND rw.given_at<? GROUP BY rw.group_id, rw.member_id`).bind(r.start, r.end));
    const pendingRw = await env.DB.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount),0) amt FROM rewards WHERE voided=0 AND approved_at IS NULL').first();
    const unassigned = await env.DB.prepare("SELECT COUNT(*) n FROM members WHERE group_id IS NULL AND status='active'").first();
    const unmatched = await env.DB.prepare('SELECT COUNT(*) n, COALESCE(SUM(active_seconds),0) secs FROM play_sessions WHERE member_id IS NULL AND start_at>=? AND start_at<?').bind(r.start, r.end).first();
    const buckets = new Map();
    const bucket = (gid) => {
      const key = gid || '';
      if (!buckets.has(key)) {
        const g = gid ? groups.get(gid) : null;
        buckets.set(key, { id: gid, name: g ? g.name : 'No group', kind: g ? g.kind : 'none', owner: g ? g.owner : '', seconds: 0, rewards: 0, players: new Map() });
      }
      return buckets.get(key);
    };
    const player = (b, row) => {
      if (!b.players.has(row.member_id)) {
        const cg = row.current_group;
        b.players.set(row.member_id, { member_no: row.member_no, name: displayName(row), nickname: row.nickname, seconds: 0, sessions: 0, days: 0, last: null, rewards: 0,
          moved_to: cg !== row.group_id ? (cg ? (groups.get(cg) || {}).name || cg : 'No group') : null });
      }
      return b.players.get(row.member_id);
    };
    for (const g of groups.values()) bucket(g.id);
    for (const row of play) { const b = bucket(row.group_id); const p = player(b, row); p.seconds += row.secs; p.sessions += row.sessions; p.days += row.days; p.last = row.last; b.seconds += row.secs; }
    for (const row of rw) { const b = bucket(row.group_id); const p = player(b, row); p.rewards += row.amt; b.rewards += row.amt; }
    const list = [...buckets.values()].map((b) => ({ ...b, players: [...b.players.values()].sort((x, y) => y.seconds - x.seconds), player_count: b.players.size }));
    list.sort((a, b) => ((groups.get(a.id) || { sort: 99 }).sort - (groups.get(b.id) || { sort: 99 }).sort));
    return reply({ from: r.from, to: r.to, groups: list, total_seconds: list.reduce((s, b) => s + b.seconds, 0), total_rewards: list.reduce((s, b) => s + b.rewards, 0),
      pending_rewards: pendingRw.n, pending_amount: pendingRw.amt,
      unassigned_members: unassigned.n, unmatched_sessions: unmatched.n, unmatched_seconds: unmatched.secs });
  }

  // ----- members list / search -----
  if (parts[0] === 'members' && parts.length === 1 && method === 'GET') {
    const q = str(url.searchParams.get('q'), 60);
    const group = str(url.searchParams.get('group'), 30);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const where = [], args = [];
    if (q) {
      const like = '%' + likeEscape(q) + '%', pre = likeEscape(q) + '%';
      const digits = /^\d{1,6}$/.test(q) ? 'EV-' + likeEscape(q) + '%' : pre;
      where.push("(member_no LIKE ? ESCAPE '\\' OR member_no LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\' OR surname LIKE ? ESCAPE '\\' OR family_name LIKE ? ESCAPE '\\' OR telegram LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')");
      args.push(pre, digits, like, like, like, like, like);
    }
    if (group === 'unassigned') where.push('group_id IS NULL');
    else if (group) { where.push('group_id=?'); args.push(group); }
    const status = str(url.searchParams.get('status'), 20);
    if (STATUSES.includes(status)) { where.push('status=?'); args.push(status); }
    const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const order = q ? "ORDER BY CASE WHEN lower(member_no)=lower(?) OR lower(member_no)=lower(?) OR lower(nickname)=lower(?) THEN 0 ELSE 1 END, member_no" : 'ORDER BY member_no';
    const rows = await all(env.DB.prepare(`SELECT members.*, EXISTS(SELECT 1 FROM member_photos p WHERE p.member_id=members.id) AS has_photo FROM members ${sqlWhere} ${order} LIMIT ? OFFSET ?`).bind(...args, ...(q ? [q, normNo(q), q] : []), limit, offset));
    const total = await env.DB.prepare(`SELECT COUNT(*) n FROM members ${sqlWhere}`).bind(...args).first();
    return reply({ members: rows.map((m) => publicMember(m, groups)), total: total.n });
  }
  if (parts[0] === 'members' && parts.length === 1 && method === 'POST') {
    const b = await readJson(req);
    const fields = pickFields(b);
    if (!fields.surname && !fields.family_name && !fields.nickname) return bad(reply, 'Name or nickname is required.');
    const groupId = b.group_id ? str(b.group_id, 30) : null;
    if (groupId && !groups.has(groupId)) return bad(reply, 'Unknown group.');
    const wanted = b.member_no ? normNo(b.member_no) : '';
    if (wanted && await memberByNo(env, wanted)) return bad(reply, 'Member number already used.', 409);
    if (wanted && await memberByOldNo(env, wanted)) {
      if (!master) return bad(reply, 'That number was used before. Ask the master account.', 409);
      await env.DB.prepare('DELETE FROM member_number_history WHERE old_no=? COLLATE NOCASE').bind(wanted).run();
    }
    const created = await createMember(env, now, fields, groupId, 'staff', who(b), wanted || null);
    return reply({ ok: true, member_no: created.member_no });
  }
  if (parts[0] === 'members' && parts[1] === 'import' && method === 'POST') {
    if (!master) return masterOnly();
    const b = await readJson(req, 1000000);
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, 100) : [];
    const actor = who(b) || 'import';
    const result = { created: 0, skipped: 0, errors: [] };
    const nos = rows.map((r) => (r.member_no ? normNo(r.member_no) : '')).filter(Boolean);
    const passports = rows.map((r) => str(r.passport_id, 40)).filter(Boolean);
    const existingNos = new Set(), existingPassports = new Set();
    if (nos.length) (await all(env.DB.prepare(`SELECT lower(member_no) n FROM members WHERE lower(member_no) IN (${marks(nos.length)})`).bind(...nos.map((n) => n.toLowerCase())))).forEach((r) => existingNos.add(r.n));
    if (passports.length) (await all(env.DB.prepare(`SELECT passport_id p FROM members WHERE passport_id IN (${marks(passports.length)})`).bind(...passports))).forEach((r) => existingPassports.add(r.p));
    let next = await nextMemberNumber(env);
    const stmts = [];
    rows.forEach((row, i) => {
      const fields = pickFields(row);
      let no = row.member_no ? normNo(row.member_no) : '';
      if (!fields.surname && !fields.family_name && !fields.nickname) { result.errors.push({ row: i, error: 'No name' }); return; }
      if (no && existingNos.has(no.toLowerCase())) { result.skipped++; return; }
      if (!no && fields.passport_id && existingPassports.has(fields.passport_id)) { result.skipped++; return; }
      const groupText = str(row.group, 30).toLowerCase();
      const group = groupText ? [...groups.values()].find((g) => g.id === groupText || g.name.toLowerCase() === groupText) : null;
      if (groupText && !group) result.errors.push({ row: i, error: 'Unknown group "' + row.group + '" — imported without group' });
      if (!no) no = formatNo(next++);
      existingNos.add(no.toLowerCase()); if (fields.passport_id) existingPassports.add(fields.passport_id);
      const cols = PROFILE_FIELDS.filter((k) => fields[k]);
      const created = isDate(str(row.created, 10)) ? dayStart(str(row.created, 10)) : now;
      stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO members(member_no,${cols.concat(['group_id', 'source', 'created_at', 'updated_at']).join(',')}) VALUES(?,${marks(cols.length + 4)})`)
        .bind(no, ...cols.map((k) => fields[k]), group ? group.id : null, 'import', created, now));
      if (group) stmts.push(env.DB.prepare('INSERT INTO member_group_history(member_id,group_id,effective_from,changed_by,note,created_at) SELECT id,?,?,?,?,? FROM members WHERE member_no=?').bind(group.id, now, actor, 'Imported', now, no));
      result.created++;
    });
    if (stmts.length) {
      stmts.push(audit(env, now, actor, 'member.import', null, `${result.created} created, ${result.skipped} skipped`));
      await env.DB.batch(stmts);
    }
    return reply(result);
  }

  // ----- one member -----
  if (parts[0] === 'members' && parts[1]) {
    const m = await memberByNo(env, parts[1]);
    if (!m) {
      const moved = method === 'GET' && parts.length === 2 ? await memberByOldNo(env, parts[1]) : null;
      return moved ? reply({ moved_to: moved.member_no }, 301) : bad(reply, 'Member not found.', 404);
    }

    if (parts.length === 2 && method === 'GET') {
      const t30 = now - 30 * DAY;
      const stat = (since) => env.DB.prepare('SELECT COUNT(*) sessions, COUNT(DISTINCT play_date) days, COALESCE(SUM(active_seconds),0) secs, COALESCE(SUM(buy_in),0) buy_in FROM play_sessions WHERE member_id=? AND start_at>=?').bind(m.id, since).first();
      const rwSum = (since) => env.DB.prepare('SELECT COALESCE(SUM(CASE WHEN approved_at IS NOT NULL THEN amount ELSE 0 END),0) amt, COALESCE(SUM(CASE WHEN approved_at IS NULL THEN amount ELSE 0 END),0) pending FROM rewards WHERE member_id=? AND voided=0 AND given_at>=?').bind(m.id, since).first();
      const [s30, sAll, r30, rAll] = await Promise.all([stat(t30), stat(0), rwSum(t30), rwSum(0)]);
      let share = null;
      if (m.group_id) {
        const g = await env.DB.prepare('SELECT COALESCE(SUM(active_seconds),0) secs FROM play_sessions WHERE group_id=? AND start_at>=?').bind(m.group_id, t30).first();
        const mine = await env.DB.prepare('SELECT COALESCE(SUM(active_seconds),0) secs FROM play_sessions WHERE group_id=? AND member_id=? AND start_at>=?').bind(m.group_id, m.id, t30).first();
        share = { group_seconds: g.secs, member_seconds: mine.secs };
      }
      const sessions = await all(env.DB.prepare('SELECT id,play_date,table_name,seat,game_type,blinds,start_at,end_at,active_seconds,rest_seconds,buy_in,transfer_note,group_id FROM play_sessions WHERE member_id=? ORDER BY start_at DESC LIMIT 200').bind(m.id));
      const rewards = await all(env.DB.prepare('SELECT id,type,detail,amount,given_at,recorded_by,approved_by,approved_at,voided,void_reason,group_id FROM rewards WHERE member_id=? ORDER BY given_at DESC, id DESC LIMIT 500').bind(m.id));
      const history = await all(env.DB.prepare('SELECT group_id,effective_from,changed_by,note FROM member_group_history WHERE member_id=? ORDER BY effective_from DESC, id DESC').bind(m.id));
      const log = await all(env.DB.prepare('SELECT at,actor,action,detail FROM audit_log WHERE member_id=? ORDER BY at DESC, id DESC LIMIT 50').bind(m.id));
      const gname = (id) => (id ? (groups.get(id) || { name: id }).name : null);
      return reply({
        member: publicMember({ ...m, has_photo: !!(await env.DB.prepare('SELECT 1 x FROM member_photos WHERE member_id=?').bind(m.id).first()) }, groups),
        stats: { last30: { ...s30, rewards: r30.amt, rewards_pending: r30.pending }, all: { ...sAll, rewards: rAll.amt, rewards_pending: rAll.pending }, group_share: share },
        sessions: sessions.map((s) => ({ ...s, group_name: gname(s.group_id) })),
        rewards: rewards.map((r) => ({ ...r, group_name: gname(r.group_id) })),
        group_history: history.map((h) => ({ ...h, group_name: gname(h.group_id) })),
        audit: log
      });
    }

    if (parts[2] === 'number' && method === 'POST') {
      if (!master) return masterOnly();
      const b = await readJson(req, 2000);
      const next = normNo(b.member_no);
      if (!/^[A-Z0-9][A-Z0-9-]{1,29}$/.test(next)) return bad(reply, 'Member number: 2–30 letters, numbers or dashes.');
      if (next === m.member_no.toUpperCase()) return reply({ ok: true, unchanged: true, member_no: m.member_no });
      // A number in use by another member is never allowed; a retired number may be reused by the master to fix a mistake.
      const taken = await env.DB.prepare('SELECT 1 x FROM members WHERE member_no=? COLLATE NOCASE AND id<>?').bind(next, m.id).first();
      if (taken) return bad(reply, 'That member number is already used.', 409);
      // Game records, rewards, photo and group history are linked by the internal id, so they all stay.
      await env.DB.batch([
        env.DB.prepare('DELETE FROM member_number_history WHERE old_no=? COLLATE NOCASE').bind(next),
        env.DB.prepare('INSERT OR REPLACE INTO member_number_history(old_no,member_id,changed_at,changed_by) VALUES(?,?,?,?)').bind(m.member_no, m.id, now, who(b)),
        env.DB.prepare('UPDATE members SET member_no=?,updated_at=? WHERE id=?').bind(next, now, m.id),
        audit(env, now, who(b), 'member.number', m.id, `${m.member_no} → ${next}`)
      ]);
      // Keep the member's place on the waiting list under the new number.
      const room = await env.DB.prepare('SELECT version,data FROM room WHERE id=1').first();
      if (room && room.data.includes(m.member_no)) {
        const st = JSON.parse(room.data); let hit = false;
        for (const q of [...(st.queue || []), ...Object.values(st.calls || {})]) if (q && q.member_no === m.member_no) { q.member_no = next; hit = true; }
        if (hit) await env.DB.prepare('UPDATE room SET version=version+1,data=? WHERE id=1 AND version=?').bind(JSON.stringify(st), room.version).run();
      }
      return reply({ ok: true, member_no: next });
    }

    if (parts[2] === 'photo' && parts.length === 3 && method === 'GET') {
      const ph = await env.DB.prepare('SELECT data,updated_at,updated_by FROM member_photos WHERE member_id=?').bind(m.id).first();
      return ph ? reply(ph) : bad(reply, 'No photo.', 404);
    }
    if (parts[2] === 'photo' && parts.length === 3 && method === 'PUT') {
      const b = await readJson(req, PHOTO_MAX + 1000);
      if (!validPhoto(b.data)) return bad(reply, 'Photo must be a JPEG, PNG or WebP image under 400 KB.');
      await env.DB.batch([
        env.DB.prepare('INSERT INTO member_photos(member_id,data,updated_at,updated_by) VALUES(?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,updated_by=excluded.updated_by').bind(m.id, b.data, now, who(b)),
        audit(env, now, who(b), 'member.photo', m.id, 'Photo updated')
      ]);
      return reply({ ok: true });
    }
    if (parts[2] === 'photo' && parts[3] === 'remove' && method === 'POST') {
      const b = await readJson(req, 2000);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM member_photos WHERE member_id=?').bind(m.id),
        audit(env, now, who(b), 'member.photo', m.id, 'Photo removed')
      ]);
      return reply({ ok: true });
    }

    if (parts.length === 2 && method === 'PUT') {
      const b = await readJson(req);
      const fields = pickFields(b);
      if ('staff_notes' in b) fields.staff_notes = str(b.staff_notes, 4000);
      if ('status' in b && b.status !== m.status) { if (!master) return masterOnly(); if (!STATUSES.includes(b.status)) return bad(reply, 'Unknown status.'); fields.status = b.status; }
      const keys = Object.keys(fields);
      if (!keys.length) return bad(reply, 'Nothing to update.');
      const changed = keys.filter((k) => fields[k] !== m[k]);
      await env.DB.batch([
        env.DB.prepare(`UPDATE members SET ${keys.map((k) => k + '=?').join(',')},updated_at=? WHERE id=?`).bind(...keys.map((k) => fields[k]), now, m.id),
        audit(env, now, who(b), 'member.update', m.id, changed.join(', '))
      ]);
      return reply({ ok: true });
    }

    if (parts[2] === 'group' && method === 'POST') {
      if (!master) return masterOnly();
      const b = await readJson(req, 5000);
      const groupId = b.group_id ? str(b.group_id, 30) : null;
      if (groupId && !groups.has(groupId)) return bad(reply, 'Unknown group.');
      if (!who(b)) return bad(reply, 'Staff name is required.');
      if (groupId === m.group_id) return reply({ ok: true, unchanged: true });
      const firstAssignment = !(await env.DB.prepare('SELECT 1 x FROM member_group_history WHERE member_id=? LIMIT 1').bind(m.id).first());
      // Effective now: past hours and rewards stay with the old group, new ones go to the new group.
      // A member's very first group also takes the play and rewards recorded before anyone assigned one.
      await env.DB.batch([
        ...(firstAssignment && groupId ? [
          env.DB.prepare('UPDATE play_sessions SET group_id=? WHERE member_id=? AND group_id IS NULL').bind(groupId, m.id),
          env.DB.prepare('UPDATE rewards SET group_id=? WHERE member_id=? AND group_id IS NULL').bind(groupId, m.id)
        ] : []),
        env.DB.prepare('UPDATE members SET group_id=?,updated_at=? WHERE id=?').bind(groupId, now, m.id),
        env.DB.prepare('INSERT INTO member_group_history(member_id,group_id,effective_from,changed_by,note,created_at) VALUES(?,?,?,?,?,?)').bind(m.id, groupId, now, who(b), str(b.note, 200), now),
        audit(env, now, who(b), 'member.group', m.id, `${m.group_id || 'none'} → ${groupId || 'none'}${b.note ? ' · ' + str(b.note, 200) : ''}`)
      ]);
      return reply({ ok: true });
    }

    if (parts[2] === 'rewards' && method === 'POST') {
      const b = await readJson(req, 5000);
      const type = str(b.type, 20);
      const amount = Number(b.amount);
      if (!REWARD_TYPES.includes(type)) return bad(reply, 'Unknown reward type.');
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > 100000000) return bad(reply, 'Amount must be a whole number of pesos.');
      if (!str(b.recorded_by, 60)) return bad(reply, 'Recorded by is required.');
      const date = str(b.date, 10);
      if (date && !isDate(date)) return bad(reply, 'Invalid date.');
      const givenAt = date && date !== localDate(now) ? dayStart(date) + 12 * 3600 : now;
      if (givenAt > now + DAY) return bad(reply, 'Date is in the future.');
      const groupId = await groupAt(env, m.id, givenAt);
      // A manager's entry is approved by that manager; a staff entry waits for a manager.
      const approver = manager ? (str(b.approved_by, 60) || who(b)) : '';
      await env.DB.batch([
        env.DB.prepare('INSERT INTO rewards(member_id,group_id,type,detail,amount,given_at,recorded_by,approved_by,approved_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .bind(m.id, groupId, type, str(b.detail, 200), amount, givenAt, str(b.recorded_by, 60), approver, manager ? now : null, now),
        audit(env, now, who(b) || b.recorded_by, 'reward.add', m.id, `${type} ₱${amount} ${str(b.detail, 120)}${manager ? '' : ' · waiting for approval'}`)
      ]);
      return reply({ ok: true, approved: manager });
    }
  }

  if (parts[0] === 'rewards' && parts[1] === 'pending' && method === 'GET') {
    const rows = await all(env.DB.prepare(`SELECT rw.id,rw.type,rw.detail,rw.amount,rw.given_at,rw.recorded_by,rw.group_id,m.member_no,m.surname,m.middle_name,m.family_name,m.nickname,m.member_no
      FROM rewards rw JOIN members m ON m.id=rw.member_id WHERE rw.voided=0 AND rw.approved_at IS NULL ORDER BY rw.given_at, rw.id LIMIT 300`));
    return reply({ rewards: rows.map((r) => ({ id: r.id, type: r.type, detail: r.detail, amount: r.amount, given_at: r.given_at, recorded_by: r.recorded_by,
      group_name: r.group_id ? (groups.get(r.group_id) || { name: r.group_id }).name : null, member_no: r.member_no, name: displayName(r), nickname: r.nickname })) });
  }
  if (parts[0] === 'rewards' && parts[1] && parts[2] === 'approve' && method === 'POST') {
    if (!manager) return managerOnly();
    const b = await readJson(req, 5000);
    const r = await env.DB.prepare('SELECT id,member_id,type,amount,voided,approved_at FROM rewards WHERE id=?').bind(Number(parts[1])).first();
    if (!r) return bad(reply, 'Reward not found.', 404);
    if (r.voided) return bad(reply, 'Reward was voided.');
    if (r.approved_at) return reply({ ok: true, unchanged: true });
    await env.DB.batch([
      env.DB.prepare('UPDATE rewards SET approved_by=?,approved_at=? WHERE id=? AND approved_at IS NULL').bind(who(b), now, r.id),
      audit(env, now, who(b), 'reward.approve', r.member_id, `${r.type} ₱${r.amount}`)
    ]);
    return reply({ ok: true });
  }
  if (parts[0] === 'rewards' && parts[1] && parts[2] === 'void' && method === 'POST') {
    if (!master) return masterOnly();
    const b = await readJson(req, 5000);
    const id = Number(parts[1]);
    if (!who(b) || !str(b.reason, 200)) return bad(reply, 'Staff name and reason are required.');
    const r = await env.DB.prepare('SELECT id,member_id,type,amount,voided FROM rewards WHERE id=?').bind(id).first();
    if (!r) return bad(reply, 'Reward not found.', 404);
    if (r.voided) return reply({ ok: true, unchanged: true });
    await env.DB.batch([
      env.DB.prepare('UPDATE rewards SET voided=1,void_reason=? WHERE id=?').bind(str(b.reason, 200), id),
      audit(env, now, who(b), 'reward.void', r.member_id, `${r.type} ₱${r.amount} · ${str(b.reason, 200)}`)
    ]);
    return reply({ ok: true });
  }

  // ----- PPM sessions that did not match a member -----
  if (parts[0] === 'sessions' && parts[1] === 'unmatched' && method === 'GET') {
    const rows = await all(env.DB.prepare('SELECT member_ref, COUNT(*) sessions, SUM(active_seconds) secs, MIN(start_at) first, MAX(start_at) last FROM play_sessions WHERE member_id IS NULL GROUP BY member_ref ORDER BY last DESC LIMIT 300'));
    // Players still at the table whose name is not a member yet.
    const live = await liveSeats(env);
    const ids = [...new Set(live.flatMap((x) => [x.auto_member, x.link_member]).filter(Boolean))];
    const names = new Map();
    for (const part of chunks(ids, 90)) (await all(env.DB.prepare(`SELECT id,member_no,nickname,surname,middle_name,family_name FROM members WHERE id IN (${marks(part.length)})`).bind(...part))).forEach((m) => names.set(m.id, m));
    const info = (id) => { const m = id ? names.get(id) : null; return m ? { member_no: m.member_no, name: displayName(m) } : null; };
    // Every player at the table: not matched first, then linked by staff, then matched automatically by number or nickname.
    const rank = (x) => (x.link_member ? 1 : x.auto_member ? 2 : 0);
    const seated = live.map((x) => ({ table: x.table, seat: x.seat, ref: x.ref, status: x.status, started: x.started, active_seconds: x.active_seconds, seat_key: x.key,
      linked: info(x.link_member), auto: info(x.auto_member) }))
      .sort((a, b) => rank(live.find((l) => l.key === a.seat_key)) - rank(live.find((l) => l.key === b.seat_key)) || a.table.localeCompare(b.table) || a.seat - b.seat);
    return reply({ refs: rows, seated });
  }
  if (parts[0] === 'sessions' && parts[1] === 'link-seat' && method === 'POST') {
    const b = await readJson(req, 5000);
    const key = str(b.seat_key, 200), staff = who(b);
    if (!key || !staff) return bad(reply, 'Seat and staff name are required.');
    const m = await memberByNo(env, str(b.member_no, 30));
    if (!m) return bad(reply, 'Member not found.', 404);
    const live = await liveSeats(env);
    const here = live.find((x) => x.key === key);
    if (!here) return bad(reply, 'This player is no longer at the table. Refresh the page.', 409);
    // Guard 1: one person cannot sit in two seats.
    const other = live.find((x) => x.key !== key && x.member_id === m.id);
    if (other) return reply({ error: `${m.member_no} (${displayName(m)}) is already at ${other.table} · S${other.seat} as "${other.ref}". Check the number.`, code: 'already_seated' }, 409);
    // Guard 2: the typed name should look like the member; staff must confirm otherwise.
    if (!b.confirm && !nameFits(here.ref, m)) return reply({ error: `PPM says "${here.ref}" but ${m.member_no} is ${displayName(m)}.`, code: 'name_mismatch', member: { member_no: m.member_no, name: displayName(m) } }, 409);
    await env.DB.batch([
      env.DB.prepare('INSERT OR REPLACE INTO ppm_seat_links(seat_key,member_id,created_at,created_by) VALUES(?,?,?,?)').bind(key, m.id, now, staff),
      audit(env, now, staff, 'sessions.link', m.id, `Seat ${key.split('|').slice(0, 3).join(' · ')}`)
    ]);
    return reply({ ok: true, member_no: m.member_no });
  }
  if (parts[0] === 'sessions' && parts[1] === 'unlink-seat' && method === 'POST') {
    const b = await readJson(req, 2000);
    const key = str(b.seat_key, 200);
    const row = await env.DB.prepare('SELECT member_id FROM ppm_seat_links WHERE seat_key=?').bind(key).first();
    if (!row) return reply({ ok: true, unchanged: true });
    await env.DB.batch([
      env.DB.prepare('DELETE FROM ppm_seat_links WHERE seat_key=?').bind(key),
      audit(env, now, who(b), 'sessions.unlink', row.member_id, `Seat ${key.split('|').slice(0, 3).join(' · ')}`)
    ]);
    return reply({ ok: true });
  }
  // Undo a wrong link on a finished session (master): it goes back to Unmatched.
  if (parts[0] === 'sessions' && /^\d+$/.test(parts[1] || '') && parts[2] === 'unlink' && method === 'POST') {
    if (!master) return masterOnly();
    const b = await readJson(req, 2000);
    const row = await env.DB.prepare('SELECT id,member_id,member_ref,play_date FROM play_sessions WHERE id=?').bind(Number(parts[1])).first();
    if (!row || !row.member_id) return reply({ ok: true, unchanged: true });
    await env.DB.batch([
      env.DB.prepare('UPDATE play_sessions SET member_id=NULL,group_id=NULL WHERE id=?').bind(row.id),
      audit(env, now, who(b), 'sessions.unlink', row.member_id, `"${row.member_ref}" · ${row.play_date}`)
    ]);
    return reply({ ok: true });
  }
  if (parts[0] === 'sessions' && parts[1] === 'link' && method === 'POST') {
    const b = await readJson(req, 5000);
    const ref = str(b.member_ref, 60), staff = who(b);
    if (!ref || !staff) return bad(reply, 'PPM name and staff name are required.');
    const m = await memberByNo(env, str(b.member_no, 30));
    if (!m) return bad(reply, 'Member not found.', 404);
    const rows = await all(env.DB.prepare('SELECT id,start_at,end_at FROM play_sessions WHERE member_id IS NULL AND member_ref=?').bind(ref));
    if (!rows.length) return reply({ ok: true, linked: 0 });
    // Guard 1: the member cannot have been playing somewhere else at the same time.
    for (const r of rows) {
      const clash = await env.DB.prepare('SELECT table_name,seat,member_ref,play_date FROM play_sessions WHERE member_id=? AND start_at<? AND end_at>? LIMIT 1').bind(m.id, r.end_at, r.start_at).first();
      if (clash) return reply({ error: `${m.member_no} (${displayName(m)}) was already playing at ${clash.table_name} · S${clash.seat} as "${clash.member_ref}" at that time. Check the number.`, code: 'overlap' }, 409);
    }
    // Guard 2: name check, staff confirm if it does not look like the member.
    if (!b.confirm && !nameFits(ref, m)) return reply({ error: `PPM says "${ref}" but ${m.member_no} is ${displayName(m)}.`, code: 'name_mismatch', member: { member_no: m.member_no, name: displayName(m) } }, 409);
    const history = await all(env.DB.prepare('SELECT member_id,group_id,effective_from FROM member_group_history WHERE member_id=? ORDER BY effective_from, id').bind(m.id));
    const stmts = rows.map((r) => env.DB.prepare('UPDATE play_sessions SET member_id=?,group_id=? WHERE id=? AND member_id IS NULL').bind(m.id, groupAtFrom(history, m.id, r.start_at), r.id));
    stmts.push(audit(env, now, staff, 'sessions.link', m.id, `"${ref}" · ${rows.length} sessions`));
    for (const part of chunks(stmts, 50)) await env.DB.batch(part);
    return reply({ ok: true, linked: rows.length });
  }

  return null;
}
