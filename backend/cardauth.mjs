// Supervisor approval at the cage: the supervisor picks their name and types their cage PIN.
// The PIN is checked here against the cage Settings (same hash as the cage page uses), so a browser cannot approve on its own.
const DEFAULT_SUPERVISORS = ['Joy', 'Geraldine', 'Cey', 'Phoebe'];
const lname = (s) => String(s || '').trim().toLowerCase();

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export const cagePinHash = (name, pin) => sha256Hex('everest|' + lname(name) + '|' + pin);

async function cageSettings(env) {
  const r = await env.DB.prepare("SELECT data FROM cage_docs WHERE coll='config' AND id='settings' AND deleted=0").first();
  try { return r ? JSON.parse(r.data) || {} : {}; } catch { return {}; }
}

// Returns the supervisor's name as written in Settings when name + PIN are right, else null.
export async function supervisorApproval(env, name, pin) {
  if (!name || !pin) return null;
  const st = await cageSettings(env);
  const sups = Array.isArray(st.supervisors) && st.supervisors.length ? st.supervisors : DEFAULT_SUPERVISORS;
  const sup = sups.find((s) => lname(s) === lname(name));
  if (!sup) return null;
  const staff = (Array.isArray(st.staff) ? st.staff : []).find((s) => s && lname(s.name) === lname(name));
  if (!staff || !staff.pin) return null;
  return staff.pin === await cagePinHash(staff.name, String(pin)) ? sup : null;
}
