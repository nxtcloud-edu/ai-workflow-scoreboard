import { createEmptySnapshot, getCachedSnapshot, refreshScores } from "../../lib/github-score.js";

export async function GET() {
  const snapshot = await readSnapshot();
  return json(toPublicSnapshot(snapshot));
}

export async function POST({ request }) {
  const body = await request.json().catch(() => ({}));
  const snapshot = await readSnapshot({ teamId: body.teamId, force: true });
  return json(toPublicSnapshot(snapshot));
}

async function readSnapshot({ teamId, force } = {}) {
  try {
    if (!force) return getCachedSnapshot() ?? await refreshScores();
    return await refreshScores({ teamId });
  } catch (error) {
    return getCachedSnapshot() ?? createEmptySnapshot(error);
  }
}

function toPublicSnapshot(snapshot) {
  return {
    refreshedAt: snapshot.refreshedAt,
    teams: (snapshot.teams ?? []).map(toPublicTeam),
    summary: snapshot.summary
  };
}

function toPublicTeam(team) {
  const { refreshError, ...publicTeam } = team;
  return {
    ...publicTeam,
    status: getPublicStatus(team)
  };
}

function getPublicStatus(team) {
  if (team.status !== "조회 실패") return team.status;
  if (team.refreshedAt || (team.rawScore ?? 0) > 0 || (team.adjustedScore ?? 0) > 0) return "이전 집계";
  return "대기";
}

function json(payload) {
  return new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
