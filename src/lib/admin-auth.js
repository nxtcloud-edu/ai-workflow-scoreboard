const SESSION_COOKIE = "scoreboard_admin";
const SESSION_VALUE = "ok";

export function requireAdmin(cookies) {
  if (!process.env.SCOREBOARD_ADMIN_PASSWORD) return json({ ok: false, error: "Admin password is not configured." }, 503);
  if (cookies.get(SESSION_COOKIE)?.value === SESSION_VALUE) return null;
  return json({ ok: false, error: "Unauthorized" }, 401);
}

export function createAdminSession(cookies) {
  cookies.set(SESSION_COOKIE, SESSION_VALUE, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 60 * 60 * 8
  });
}

export function clearAdminSession(cookies) {
  cookies.delete(SESSION_COOKIE, { path: "/" });
}

export function isValidPassword(password) {
  return Boolean(process.env.SCOREBOARD_ADMIN_PASSWORD) && password === process.env.SCOREBOARD_ADMIN_PASSWORD;
}

export function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
