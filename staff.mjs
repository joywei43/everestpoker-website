// Staff account management for managers. Passwords are hashed with salted PBKDF2-SHA256 (Workers cap: 100,000 iterations).
export const ITERATIONS = 100000;
const hex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
export async function hashPassword(password, saltHex, iterations = ITERATIONS) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
export const newSalt = () => hex(crypto.getRandomValues(new Uint8Array(16)));

const bad = (reply, msg, status = 400) => reply({ error: msg }, status);
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const ROLES = ['admin', 'staff'];

export async function handleStaff(req, env, path, now, reply, user, role, isMaster = () => false) {
  // Only the master account manages staff accounts.
  if (role !== 'master') return bad(reply, 'Only the master account can manage staff accounts.', 403);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const text = await req.text(); if (text.length > 4000) return bad(reply, 'Too large', 413);
  const b = text ? JSON.parse(text) : {};
  const log = (action, detail) => env.DB.prepare('INSERT INTO audit_log(at,actor,action,member_id,detail) VALUES(?,?,?,NULL,?)').bind(now, clean(user, 60) || 'admin01', action, detail);

  if (parts.length === 1 && req.method === 'GET') {
    const rows = (await env.DB.prepare('SELECT username,display_name,role,active,created_at FROM staff ORDER BY active DESC, display_name COLLATE NOCASE').all()).results || [];
    return reply({ staff: rows.map((r) => ({ ...r, role: isMaster(r.username) ? 'master' : r.role })), me: user });
  }
  if (parts.length === 1 && req.method === 'POST') {
    const name = clean(b.username, 60), password = typeof b.password === 'string' ? b.password : '';
    const r = ROLES.includes(b.role) ? b.role : 'staff';
    if (!/^[\p{L}\p{N}._ -]{2,60}$/u.test(name)) return bad(reply, 'Username: 2–60 letters, numbers, spaces, dots or dashes.');
    if (password.length < 6 || password.length > 200) return bad(reply, 'Password must be at least 6 characters.');
    if (await env.DB.prepare('SELECT 1 x FROM staff WHERE username=?').bind(name).first()) return bad(reply, 'That username is taken.', 409);
    const salt = newSalt();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO staff(username,display_name,pw_hash,salt,iterations,role,active,created_at) VALUES(?,?,?,?,?,?,1,?)').bind(name, name, await hashPassword(password, salt), salt, ITERATIONS, r, now),
      log('staff.create', `${name} (${r})`)
    ]);
    return reply({ ok: true });
  }
  if (parts.length === 3 && parts[2] === 'delete' && req.method === 'POST') {
    const target = await env.DB.prepare('SELECT username FROM staff WHERE username=?').bind(parts[1]).first();
    if (!target) return bad(reply, 'Account not found.', 404);
    if (isMaster(target.username)) return bad(reply, 'The master account cannot be deleted.');
    // Past log entries keep the person's name; only the sign-in is removed.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE token IN (SELECT token FROM session_users WHERE username=?)').bind(target.username),
      env.DB.prepare('DELETE FROM session_users WHERE username=?').bind(target.username),
      env.DB.prepare('DELETE FROM staff WHERE username=?').bind(target.username),
      log('staff.delete', target.username)
    ]);
    return reply({ ok: true });
  }
  if (parts.length === 2 && req.method === 'PUT') {
    const target = await env.DB.prepare('SELECT username,role,active FROM staff WHERE username=?').bind(parts[1]).first();
    if (!target) return bad(reply, 'Account not found.', 404);
    if (isMaster(target.username) && ('role' in b || 'active' in b)) return bad(reply, 'The master account is set in the system settings and cannot be changed here.');
    const self = clean(user, 60).toLowerCase() === target.username.toLowerCase();
    const sets = [], args = [], changes = [];
    if ('role' in b) {
      if (!ROLES.includes(b.role)) return bad(reply, 'Unknown role.');
      if (self && b.role !== 'admin') return bad(reply, 'You cannot remove your own manager role.');
      sets.push('role=?'); args.push(b.role); changes.push('role ' + b.role);
    }
    if ('active' in b) {
      if (self && !b.active) return bad(reply, 'You cannot disable your own account.');
      sets.push('active=?'); args.push(b.active ? 1 : 0); changes.push(b.active ? 'enabled' : 'disabled');
    }
    if ('password' in b) {
      if (typeof b.password !== 'string' || b.password.length < 6 || b.password.length > 200) return bad(reply, 'Password must be at least 6 characters.');
      const salt = newSalt();
      sets.push('pw_hash=?', 'salt=?', 'iterations=?'); args.push(await hashPassword(b.password, salt), salt, ITERATIONS); changes.push('password reset');
    }
    if (!sets.length) return bad(reply, 'Nothing to change.');
    const stmts = [env.DB.prepare(`UPDATE staff SET ${sets.join(',')} WHERE username=?`).bind(...args, target.username), log('staff.update', `${target.username}: ${changes.join(', ')}`)];
    // Disabling an account or resetting its password signs it out everywhere.
    if (('active' in b && !b.active) || 'password' in b) stmts.push(env.DB.prepare('DELETE FROM sessions WHERE token IN (SELECT token FROM session_users WHERE username=?)').bind(target.username), env.DB.prepare('DELETE FROM session_users WHERE username=?').bind(target.username));
    if ('role' in b) stmts.push(env.DB.prepare('UPDATE session_users SET role=? WHERE username=?').bind(b.role, target.username));
    await env.DB.batch(stmts);
    return reply({ ok: true });
  }
  return null;
}
