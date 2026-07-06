import { clearCachedSnapshot } from "../../../lib/github-score.js";
import { json, requireAdmin } from "../../../lib/admin-auth.js";
import {
  addScoreboardRepo,
  getScoreboardRepos,
  parseGithubRepo,
  removeScoreboardRepo
} from "../../../lib/repo-registry.js";

export async function GET({ cookies }) {
  const unauthorized = requireAdmin(cookies);
  if (unauthorized) return unauthorized;

  return json({ ok: true, repos: await getScoreboardRepos() });
}

export async function POST({ request, cookies }) {
  const unauthorized = requireAdmin(cookies);
  if (unauthorized) return unauthorized;

  const body = await request.json().catch(() => ({}));
  const repo = parseGithubRepo(body.repoUrl ?? body.repo);
  if (!repo) return json({ ok: false, error: "GitHub public repo 링크를 입력해 주세요." }, 400);

  try {
    const repoInfo = await readPublicRepo(repo);
    const repos = await addScoreboardRepo({
      repo,
      label: body.label || `${repoInfo.owner.login}/${repoInfo.name}`
    });
    clearCachedSnapshot();
    return json({ ok: true, repos });
  } catch (error) {
    return json({ ok: false, error: sanitizeError(error) }, 400);
  }
}

export async function DELETE({ request, cookies }) {
  const unauthorized = requireAdmin(cookies);
  if (unauthorized) return unauthorized;

  const body = await request.json().catch(() => ({}));
  if (!body.id) return json({ ok: false, error: "삭제할 repo id가 필요합니다." }, 400);

  try {
    const repos = await removeScoreboardRepo(body.id);
    clearCachedSnapshot();
    return json({ ok: true, repos });
  } catch (error) {
    return json({ ok: false, error: sanitizeError(error) }, 400);
  }
}

async function readPublicRepo(repo) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "nxtcloud-ai-workflow-scoreboard"
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const response = await fetch(`https://api.github.com/repos/${repo}`, { headers });
  if (!response.ok) {
    throw new Error("GitHub에서 repo를 찾지 못했습니다. public repo 링크인지 확인해 주세요.");
  }

  const payload = await response.json();
  if (payload.private) throw new Error("private repo는 이 점수판에 등록하지 않습니다.");
  return payload;
}

function sanitizeError(error) {
  return String(error?.message ?? error ?? "알 수 없는 오류")
    .replace(/\s+/g, " ")
    .slice(0, 220);
}
