// Approval at the cage: a manager types their own Admin username and password (the cashier stays signed in).
// Only Manager (admin) and Master accounts can approve. Wrong tries are limited per account, like the sign-in.
const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf)).map((v) => v.toString(16).padStart(2, '0')).join('');
const digest = async (v) => hex(await crypto.subtle.digest('SHA-256', enc.encode(v)));
async function pbkdf2(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16))), iterations }, key, 256));
}
async function equal(a, b) { const x = await digest(a), y = await digest(b); let d = 0; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i); return d === 0; }
const isMaster = (env, u) => !!u && (env.MASTER_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).includes(String(u).toLowerCase());

// Returns { name } of the approving manager, or { error, status } when it cannot approve.
export async function managerApproval(env, username, password, now = Math.floor(Date.now() / 1000)) {
  const u = typeof username === 'string' ? username.trim() : '';
  if (!u || u.length > 60 || typeof password !== 'string' || !password || password.length > 200) return { error: 'A manager types their Admin username and password.', status: 403 };
  const key = 'approve|' + (await digest(u.toLowerCase()));
  const tries = await env.DB.prepare('SELECT started,count FROM attempts WHERE ip=?').bind(key).first();
  if (tries && tries.started >= now - 900 && tries.count >= 5) return { error: 'Too many wrong tries. Wait 15 minutes.', status: 429 };
  const staff = await env.DB.prepare('SELECT username,display_name,pw_hash,salt,iterations,active,role FROM staff WHERE username=?').bind(u).first();
  let name = null, manager = false;
  if (staff) {
    if (staff.active && await equal(await pbkdf2(password, staff.salt, staff.iterations), staff.pw_hash)) {
      name = staff.display_name;
      manager = isMaster(env, staff.username) || !['staff', 'senior', 'dealer'].includes(staff.role);
    }
  } else if (u.toLowerCase() === 'admin01' && env.ADMIN_PASSWORD && await equal(password, env.ADMIN_PASSWORD)) { name = 'admin01'; manager = true; }
  if (!name) {
    await env.DB.prepare('INSERT INTO attempts (ip,started,count) VALUES (?,?,1) ON CONFLICT(ip) DO UPDATE SET count=CASE WHEN started<? THEN 1 ELSE count+1 END,started=CASE WHEN started<? THEN ? ELSE started END')
      .bind(key, now, now - 900, now - 900, now).run();
    return { error: 'Wrong username or password.', status: 403 };
  }
  await env.DB.prepare('DELETE FROM attempts WHERE ip=?').bind(key).run();
  if (!manager) return { error: `${name} is not a manager account, so cannot approve.`, status: 403 };
  return { name };
}
