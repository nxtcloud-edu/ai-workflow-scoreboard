import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const OWNER = "nxtcloud-edu";
const TEAM_COUNT = 5;
const STORE_FILE = process.env.SCOREBOARD_REPOS_FILE ?? join(process.cwd(), ".data", "repos.json");
const TEAM_MEMBERS = {
  team1: ["ChoHyeonChan", "juneddoha", "junseok0929"],
  team2: ["k4nul", "asakicode", "pahaha404"],
  team3: ["codeNBogus", "KMU-jeonghj", "williamjeon7"],
  team4: ["2wodnjs7", "Chyopriushy", "xxrthscrclz"],
  team5: ["kyjkmu1828-coder", "aldfula", "HyeonWooNa0861"]
};
const TEAM_MEMBER_ALIASES = {
  team5: {
    "나현우": "HyeonWooNa0861"
  }
};

export function getDefaultScoreboardRepos() {
  return Array.from({ length: TEAM_COUNT }, (_, index) => {
    const teamNumber = index + 1;
    const id = `team${teamNumber}`;
    const expectedLogins = TEAM_MEMBERS[id] ?? [];
    return {
      id,
      label: `Team ${teamNumber}`,
      repo: `${OWNER}/2026-kookmin-ai-workflow-team${teamNumber}`,
      expectedMembers: expectedLogins.length,
      expectedLogins,
      memberAliases: TEAM_MEMBER_ALIASES[id] ?? {},
      source: "default"
    };
  });
}

export async function getScoreboardRepos() {
  const storedRepos = await readStoredRepos();
  return normalizeRepos(storedRepos ?? getDefaultScoreboardRepos());
}

export async function addScoreboardRepo({ repo, label }) {
  const repos = await getScoreboardRepos();
  const normalizedRepo = normalizeRepoName(repo);
  if (!normalizedRepo) throw new Error("GitHub repo 형식이 올바르지 않습니다.");

  if (repos.some((item) => item.repo.toLowerCase() === normalizedRepo.toLowerCase())) {
    throw new Error("이미 등록된 repo입니다.");
  }

  const nextRepo = {
    id: createRepoId(normalizedRepo),
    label: label?.trim() || normalizedRepo,
    repo: normalizedRepo,
    expectedMembers: 0,
    expectedLogins: [],
    source: "admin"
  };
  const nextRepos = [...repos, nextRepo];
  await writeStoredRepos(nextRepos);
  return normalizeRepos(nextRepos);
}

export async function removeScoreboardRepo(id) {
  const repos = await getScoreboardRepos();
  const nextRepos = repos.filter((repo) => repo.id !== id);
  if (nextRepos.length === repos.length) throw new Error("삭제할 repo를 찾지 못했습니다.");
  await writeStoredRepos(nextRepos);
  return normalizeRepos(nextRepos);
}

export function parseGithubRepo(input) {
  const value = String(input ?? "").trim();
  if (!value) return null;

  const directMatch = value.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (directMatch) return `${directMatch[1]}/${directMatch[2]}`;

  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") return null;
    const [owner, name] = url.pathname.split("/").filter(Boolean);
    if (!owner || !name) return null;
    return `${owner}/${name.replace(/\.git$/i, "")}`;
  } catch {
    return null;
  }
}

function normalizeRepoName(repo) {
  const parsedRepo = parseGithubRepo(repo);
  if (!parsedRepo) return null;
  const [owner, name] = parsedRepo.split("/");
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

async function readStoredRepos() {
  try {
    const payload = JSON.parse(await readFile(STORE_FILE, "utf8"));
    return Array.isArray(payload?.repos) ? payload.repos : [];
  } catch {
    return null;
  }
}

async function writeStoredRepos(repos) {
  await mkdir(dirname(STORE_FILE), { recursive: true });
  await writeFile(STORE_FILE, JSON.stringify({ repos: normalizeRepos(repos) }, null, 2));
}

function normalizeRepos(repos) {
  return repos
    .map((repo) => {
      const normalizedRepo = normalizeRepoName(repo.repo);
      if (!normalizedRepo) return null;
      const id = repo.id || createRepoId(normalizedRepo);
      const configuredAliases = repo.memberAliases && typeof repo.memberAliases === "object" ? repo.memberAliases : {};
      return {
        id,
        label: repo.label || normalizedRepo,
        repo: normalizedRepo,
        expectedMembers: Array.isArray(repo.expectedLogins) ? repo.expectedLogins.length : 0,
        expectedLogins: Array.isArray(repo.expectedLogins) ? repo.expectedLogins : [],
        memberAliases: {
          ...(TEAM_MEMBER_ALIASES[id] ?? {}),
          ...configuredAliases
        },
        source: repo.source || "admin"
      };
    })
    .filter(Boolean);
}

function createRepoId(repo) {
  return repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
