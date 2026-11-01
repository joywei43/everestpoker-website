// Prints SQL that creates or resets staff accounts. Run it on your own computer:
//   node create-staff.mjs "Geraldine:password" "Joy:password" > staff-accounts.sql
//   npx wrangler d1 execute everest-waiting --remote --file=staff-accounts.sql
// Then delete staff-accounts.sql. Never commit it: the repository is public.
import { webcrypto as crypto } from 'node:crypto';
export const ITERATIONS = 100000; // Cloudflare Workers allow at most 100,000 PBKDF2 iterations.
const hex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
export async function hashPassword(password, saltHex, iterations = ITERATIONS) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
export async function staffSql(pairs, now = Math.floor(Date.now() / 1000)) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const lines = [];
  for (const pair of pairs) {
    const i = pair.indexOf(':');
    const name = pair.slice(0, i).trim(), password = pair.slice(i + 1);
    if (i < 1 || !name || name.length > 60 || password.length < 4) throw new Error('Use "Name:password" (password at least 4 characters): ' + pair);
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await hashPassword(password, salt);
    lines.push(`INSERT INTO staff(username,display_name,pw_hash,salt,iterations,role,active,created_at) VALUES(${q(name)},${q(name)},${q(hash)},${q(salt)},${ITERATIONS},'admin',1,${now}) ON CONFLICT(username) DO UPDATE SET display_name=excluded.display_name,pw_hash=excluded.pw_hash,salt=excluded.salt,iterations=excluded.iterations,active=1;`);
  }
  return lines.join('\n') + '\n';
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const pairs = process.argv.slice(2);
  if (!pairs.length) { console.error('Usage: node create-staff.mjs "Name:password" ...'); process.exit(1); }
  process.stdout.write(await staffSql(pairs));
}
