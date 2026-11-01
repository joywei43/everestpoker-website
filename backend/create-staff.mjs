// Prints SQL that creates or resets staff accounts. Run it on your own computer:
//   node create-staff.mjs "Geraldine:password" "Maria:password:staff" > staff-accounts.sql
// Role is admin (manager, the default) or staff (floor and counter).
//   npx wrangler d1 execute everest-waiting --remote --file=staff-accounts.sql
// Then delete staff-accounts.sql. Never commit it: the repository is public.
import { hashPassword, newSalt, ITERATIONS } from './staff.mjs';
export { hashPassword };
export async function staffSql(pairs, now = Math.floor(Date.now() / 1000)) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const lines = [];
  for (const pair of pairs) {
    let rest = pair, role = 'admin';
    const m = /:(admin|staff)$/.exec(pair);
    if (m && pair.indexOf(':') < m.index) { role = m[1]; rest = pair.slice(0, m.index); }
    const i = rest.indexOf(':');
    const name = rest.slice(0, i).trim(), password = rest.slice(i + 1);
    if (i < 1 || !name || name.length > 60 || password.length < 4) throw new Error('Use "Name:password" or "Name:password:staff" (password at least 4 characters): ' + pair);
    const salt = newSalt();
    const hash = await hashPassword(password, salt);
    lines.push(`INSERT INTO staff(username,display_name,pw_hash,salt,iterations,role,active,created_at) VALUES(${q(name)},${q(name)},${q(hash)},${q(salt)},${ITERATIONS},${q(role)},1,${now}) ON CONFLICT(username) DO UPDATE SET display_name=excluded.display_name,pw_hash=excluded.pw_hash,salt=excluded.salt,iterations=excluded.iterations,role=excluded.role,active=1;`);
  }
  return lines.join('\n') + '\n';
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const pairs = process.argv.slice(2);
  if (!pairs.length) { console.error('Usage: node create-staff.mjs "Name:password" ...'); process.exit(1); }
  process.stdout.write(await staffSql(pairs));
}
