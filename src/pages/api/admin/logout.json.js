import { clearAdminCookie, json } from "../../../lib/admin-auth.js";

export async function POST({ cookies }) {
  clearAdminCookie(cookies);
  return json({ ok: true });
}
