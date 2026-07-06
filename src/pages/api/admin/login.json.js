import { createAdminSession, isValidPassword, json } from "../../../lib/admin-auth.js";

export async function POST({ request, cookies }) {
  const body = await request.json().catch(() => ({}));
  if (!isValidPassword(body.password)) return json({ ok: false, error: "비밀번호를 확인해 주세요." }, 401);
  createAdminSession(cookies);
  return json({ ok: true });
}
