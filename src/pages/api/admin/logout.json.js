import { clearAdminSession, json } from "../../../lib/admin-auth.js";

export async function POST({ cookies }) {
  clearAdminSession(cookies);
  return json({ ok: true });
}
