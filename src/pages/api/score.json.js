import { createEmptySnapshot, getCachedSnapshot, refreshScores } from "../../lib/github-score.js";

export async function GET() {
  const snapshot = await readSnapshot();

  return json(snapshot);
}

export async function POST({ request }) {
  const body = await request.json().catch(() => ({}));
  const snapshot = await readSnapshot({ teamId: body.teamId, force: true });

  return json(snapshot);
}

async function readSnapshot({ teamId, force } = {}) {
  try {
    if (!force) return getCachedSnapshot() ?? await refreshScores();
    return await refreshScores({ teamId });
  } catch (error) {
    return getCachedSnapshot() ?? createEmptySnapshot(error);
  }
}

function json(snapshot) {
  return new Response(JSON.stringify(toPublicSnapshot(snapshot)), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
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
    quality: toPublicQuality(team.quality),
    status: getPublicStatus(team)
  };
}

function toPublicQuality(quality) {
  if (!quality) return quality;

  const items = (quality.items ?? []).filter((item) => item.type !== "system");
  if (items.length > 0) return { ...quality, items };

  if (quality.items?.some((item) => item.type === "system")) {
    return {
      ...quality,
      status: "품질 평가 대기",
      summary: "정량 점수는 표시되며, 품질 평가는 다음 갱신에서 다시 시도됩니다.",
      items: [],
      error: null
    };
  }

  return quality;
}

function getPublicStatus(team) {
  if (team.status !== "조회 실패") return team.status;
  if (team.refreshedAt || (team.rawScore ?? 0) > 0 || (team.adjustedScore ?? 0) > 0) return "이전 집계";
  return "대기";
}
