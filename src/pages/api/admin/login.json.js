import { isAdminPassword, json, setAdminCookie } from "../../../lib/admin-auth.js";

export async function POST({ request, cookies }) {
  const body = await request.json().catch(() => ({}));
  if (!isAdminPassword(body.password)) {
    return json({ ok: false, error: "비밀번호가 올바르지 않습니다." }, 401);
  }

  setAdminCookie(cookies);
  return json({ ok: true });
}
