import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "scoreboard_admin";
const ADMIN_PASSWORD = process.env.SCOREBOARD_ADMIN_PASSWORD ?? "12345678aA";
const SESSION_SECRET = process.env.SCOREBOARD_ADMIN_SESSION_SECRET ?? ADMIN_PASSWORD;
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;

export function isAdminPassword(password) {
  return safeEqual(String(password ?? ""), ADMIN_PASSWORD);
}

export function setAdminCookie(cookies) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const session = `${expiresAt}.${signSession(expiresAt)}`;
  cookies.set(COOKIE_NAME, session, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    maxAge: Math.floor(SESSION_TTL_MS / 1000)
  });
}

export function clearAdminCookie(cookies) {
  cookies.delete(COOKIE_NAME, { path: "/" });
}

export function requireAdmin(cookies) {
  if (isAdmin(cookies)) return null;
  return json({ ok: false, error: "관리자 인증이 필요합니다." }, 401);
}

export function isAdmin(cookies) {
  const session = cookies.get(COOKIE_NAME)?.value;
  if (!session) return false;

  const [expiresAtText, signature] = session.split(".");
  const expiresAt = Number(expiresAtText);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;

  return safeEqual(signature, signSession(expiresAt));
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

function signSession(expiresAt) {
  return createHmac("sha256", SESSION_SECRET).update(`admin:${expiresAt}`).digest("hex");
}

function safeEqual(first, second) {
  const firstBuffer = Buffer.from(String(first));
  const secondBuffer = Buffer.from(String(second));
  if (firstBuffer.length !== secondBuffer.length) return false;
  return timingSafeEqual(firstBuffer, secondBuffer);
}
