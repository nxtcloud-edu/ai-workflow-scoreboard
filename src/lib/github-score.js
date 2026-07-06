import fs from "node:fs";
import path from "node:path";
import { createEmptyQuality, evaluateTeamQuality } from "./quality-evaluator.js";
import { getDefaultScoreboardRepos, getScoreboardRepos } from "./repo-registry.js";

const EXCLUDED_LOGINS = new Set(
  (process.env.SCOREBOARD_EXCLUDED_LOGINS ?? "glen15,Dang-Mu")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean)
);

const SNAPSHOT_FILE = process.env.SCOREBOARD_SNAPSHOT_FILE ?? path.join(process.cwd(), ".cache", "scoreboard-snapshot.json");
const riskFilePattern = /(^|\/)(\.env|id_rsa|.*\.pem|.*\.key|.*secret.*|.*token.*)$/i;

let cachedSnapshot = null;

export function getCachedSnapshot() {
  const snapshot = cachedSnapshot ?? readSnapshotFromDisk();
  if (!snapshot) return null;
  cachedSnapshot = normalizeSnapshotScores(snapshot);
  return cachedSnapshot;
}

export function clearCachedSnapshot() {
  cachedSnapshot = null;
  try {
    fs.unlinkSync(SNAPSHOT_FILE);
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("Failed to clear scoreboard snapshot", error);
  }
}

export async function refreshScores({ teamId } = {}) {
  const teams = await getScoreboardRepos();
  const previousSnapshot = getCachedSnapshot();
  const previousTeams = new Map((previousSnapshot?.teams ?? []).map((team) => [team.id, team]));
  const targetTeams = teamId ? teams.filter((team) => team.id === teamId) : teams;
  const results = await Promise.all(targetTeams.map(refreshTeamSafely));
  const refreshed = new Map(results.filter((result) => result.ok).map((result) => [result.team.id, result.team]));
  const failed = new Map(results.filter((result) => !result.ok).map((result) => [result.team.id, result.error]));

  const mergedTeams = teams.map((team) => {
    if (refreshed.has(team.id)) return refreshed.get(team.id);
    const fallback = normalizeCachedTeamForConfig(previousTeams.get(team.id) ?? emptyTeamScore(team), team);
    if (!failed.has(team.id)) return fallback;
    return { ...fallback, status: "조회 실패", refreshError: failed.get(team.id), refreshedAt: new Date().toISOString() };
  });

  cachedSnapshot = {
    refreshedAt: new Date().toISOString(),
    excludedLogins: [...EXCLUDED_LOGINS],
    teams: mergedTeams,
    summary: summarize(mergedTeams),
    error: failed.size ? [...failed.values()].join("; ") : null
  };
  writeSnapshotToDisk(cachedSnapshot);
  return cachedSnapshot;
}

export function createEmptySnapshot(error) {
  const emptyTeams = getDefaultScoreboardRepos().map(emptyTeamScore);
  return {
    refreshedAt: new Date().toISOString(),
    excludedLogins: [...EXCLUDED_LOGINS],
    teams: emptyTeams,
    summary: summarize(emptyTeams),
    error: sanitizeError(error)
  };
}

async function refreshTeamSafely(team) {
  try {
    return { ok: true, team: await loadTeamScore(team) };
  } catch (error) {
    return { ok: false, team, error: sanitizeError(error) };
  }
}

async function loadTeamScore(team) {
  const { commits, prDetails } = await loadTeamActivity(team);
  const scoredCommits = dedupeCommits([...commits, ...prDetails.flatMap((detail) => detail.pullCommits)]).filter(
    (commit) => !isExcludedLogin(getCommitAuthorLogin(commit, team.expectedLogins, team.memberAliases))
  );
  const scoredPrDetails = prDetails.filter(({ pull }) => !isExcludedLogin(pull.user?.login));
  const hasStudentActivity = scoredCommits.length > 0 || scoredPrDetails.length > 0;
  const peerReviewStats = collectPeerReviewStats(scoredPrDetails, team.expectedLogins, team.memberAliases);
  const activity = collectActivity({
    commits: scoredCommits,
    prDetails: scoredPrDetails,
    expectedLogins: team.expectedLogins,
    memberAliases: team.memberAliases
  });
  const quality = hasStudentActivity ? await evaluateTeamQuality({ team, commits: scoredCommits, prDetails: scoredPrDetails }) : createEmptyQuality();
  const balance = calculateBalance(activity.members, team.expectedLogins);
  const prCycleScore = calculatePrCycleScore(scoredPrDetails, peerReviewStats);
  const commitPracticeScore = scoredCommits.length * 2;
  const reviewScore = peerReviewStats.reviewCount * 10 + peerReviewStats.commentCount * 2;
  const hygieneScore = hasStudentActivity ? calculateHygieneScore(scoredPrDetails) : 0;
  const rawScore = hasStudentActivity ? prCycleScore + commitPracticeScore + reviewScore + hygieneScore : 0;
  const balanceMultiplier = hasStudentActivity ? calculateBalanceMultiplier(balance.score) : 0;
  const qualityMultiplier = hasStudentActivity ? calculateQualityMultiplier(quality, peerReviewStats) : 0;
  const totalMultiplier = roundMultiplier(balanceMultiplier * qualityMultiplier);
  const adjustedScore = Math.round(rawScore * totalMultiplier);

  return {
    ...team,
    score: adjustedScore,
    rawScore,
    adjustedScore,
    status: getStatus({ rawScore, balance, quality }),
    refreshedAt: new Date().toISOString(),
    metrics: {
      commits: scoredCommits.length,
      pulls: scoredPrDetails.length,
      mergedPulls: scoredPrDetails.filter(({ pull }) => pull.merged_at).length,
      openPulls: scoredPrDetails.filter(({ pull }) => pull.state === "open").length,
      peerReviewedPulls: peerReviewStats.peerReviewedPulls,
      mergedPeerReviewedPulls: peerReviewStats.mergedPeerReviewedPulls,
      peerReviewCoverage: peerReviewStats.coverage,
      reviews: peerReviewStats.reviewCount,
      comments: peerReviewStats.commentCount,
      riskyFiles: scoredPrDetails.flatMap((detail) => detail.files).filter((file) => riskFilePattern.test(file.filename)),
      lastActivityAt: findLastActivityAt({ commits: scoredCommits, prDetails: scoredPrDetails })
    },
    multipliers: {
      balance: balanceMultiplier,
      quality: qualityMultiplier,
      total: totalMultiplier
    },
    components: {
      rawTotal: rawScore,
      prCycle: prCycleScore,
      prFlow: prCycleScore,
      commits: commitPracticeScore,
      commitPractice: commitPracticeScore,
      review: reviewScore,
      peerReview: reviewScore,
      hygiene: hygieneScore
    },
    members: balance.members,
    quality,
    refreshError: null
  };
}

async function loadTeamActivity(team) {
  const [commits, pulls] = await Promise.all([
    githubJson(`/repos/${team.repo}/commits?per_page=100`),
    githubJson(`/repos/${team.repo}/pulls?state=all&per_page=100`)
  ]);

  const prDetails = await Promise.all(
    pulls.map(async (pull) => {
      const [reviews, issueComments, reviewComments, files, pullCommits] = await Promise.all([
        githubJson(`/repos/${team.repo}/pulls/${pull.number}/reviews?per_page=100`),
        githubJson(`/repos/${team.repo}/issues/${pull.number}/comments?per_page=100`),
        githubJson(`/repos/${team.repo}/pulls/${pull.number}/comments?per_page=100`),
        githubJson(`/repos/${team.repo}/pulls/${pull.number}/files?per_page=100`),
        githubJson(`/repos/${team.repo}/pulls/${pull.number}/commits?per_page=100`)
      ]);
      return { pull, reviews, issueComments, reviewComments, files, pullCommits };
    })
  );

  return { commits, prDetails };
}

function collectActivity({ commits, prDetails, expectedLogins, memberAliases }) {
  const members = new Map(expectedLogins.map((login) => [login, { login, points: 0, share: 0, placeholder: false }]));
  const addPoints = (login, points) => {
    const normalized = normalizeLogin(login, expectedLogins, memberAliases);
    if (!normalized || isExcludedLogin(normalized)) return;
    if (!members.has(normalized)) members.set(normalized, { login: normalized, points: 0, share: 0, placeholder: false });
    members.get(normalized).points += points;
  };

  commits.forEach((commit) => addPoints(getCommitAuthorLogin(commit, expectedLogins, memberAliases), 2));
  prDetails.forEach((detail) => {
    addPoints(detail.pull.user?.login, 4);
    if (detail.pull.merged_at) addPoints(detail.pull.user?.login, 6);
    collectReviewActors(detail).forEach((actor) => addPoints(actor, 4));
  });

  const total = [...members.values()].reduce((sum, member) => sum + member.points, 0);
  return {
    members: [...members.values()].map((member) => ({
      ...member,
      points: round(member.points),
      share: total > 0 ? Math.round((member.points / total) * 100) : 0
    }))
  };
}

function collectPeerReviewStats(prDetails, expectedLogins, memberAliases) {
  let peerReviewedPulls = 0;
  let mergedPeerReviewedPulls = 0;
  let reviewCount = 0;
  let commentCount = 0;

  for (const detail of prDetails) {
    const author = normalizeLogin(detail.pull.user?.login, expectedLogins, memberAliases);
    const reviewActors = new Set();
    const commentActors = new Set();

    for (const review of detail.reviews) {
      const login = normalizeLogin(review.user?.login, expectedLogins, memberAliases);
      if (login && login !== author && !isExcludedLogin(login)) reviewActors.add(login);
    }
    for (const comment of [...detail.issueComments, ...detail.reviewComments]) {
      const login = normalizeLogin(comment.user?.login, expectedLogins, memberAliases);
      if (login && login !== author && !isExcludedLogin(login)) commentActors.add(login);
    }

    const hasPeerSignal = reviewActors.size > 0 || commentActors.size > 0;
    if (hasPeerSignal) peerReviewedPulls += 1;
    if (hasPeerSignal && detail.pull.merged_at) mergedPeerReviewedPulls += 1;
    reviewCount += reviewActors.size;
    commentCount += commentActors.size;
  }

  return {
    peerReviewedPulls,
    mergedPeerReviewedPulls,
    reviewCount,
    commentCount,
    coverage: prDetails.length ? Math.round((peerReviewedPulls / prDetails.length) * 100) : 0
  };
}

function collectReviewActors(detail) {
  return [
    ...detail.reviews.map((review) => review.user?.login),
    ...detail.issueComments.map((comment) => comment.user?.login),
    ...detail.reviewComments.map((comment) => comment.user?.login)
  ].filter(Boolean);
}

function calculatePrCycleScore(prDetails, peerReviewStats) {
  const opened = prDetails.length * 4;
  const merged = prDetails.filter(({ pull }) => pull.merged_at).length * 6;
  const peerReviewed = peerReviewStats.peerReviewedPulls * 10;
  return opened + merged + peerReviewed;
}

function calculateHygieneScore(prDetails) {
  const hasRisk = prDetails.some((detail) => detail.files.some((file) => riskFilePattern.test(file.filename)));
  const hasOpen = prDetails.some(({ pull }) => pull.state === "open");
  return (hasRisk ? 0 : 3) + (hasOpen ? 1 : 2);
}

function calculateBalance(members, expectedLogins) {
  const expectedCount = Math.max(expectedLogins.length, members.length, 1);
  const idealShare = 100 / expectedCount;
  const activeMembers = members.filter((member) => member.points > 0);
  if (activeMembers.length === 0) return { score: 0, members };

  const averageDistance = members.reduce((sum, member) => sum + Math.abs(member.share - idealShare), 0) / expectedCount;
  const score = Math.max(0, Math.min(100, 100 - averageDistance * 2));
  return { score, members };
}

function calculateBalanceMultiplier(score) {
  if (score >= 85) return 1.15;
  if (score >= 70) return 1.08;
  if (score >= 50) return 1;
  if (score >= 30) return 0.86;
  return 0.7;
}

function calculateQualityMultiplier(quality, peerReviewStats) {
  if (quality.status === "정상" && peerReviewStats.coverage >= 70) return 1.06;
  if (quality.status === "리뷰 부족") return 0.94;
  if (quality.status === "사람 확인 필요") return 0.9;
  return 1;
}

function getStatus({ rawScore, balance, quality }) {
  if (rawScore === 0) return "대기";
  if (quality.status === "사람 확인 필요") return "확인 필요";
  if (balance.score < 45) return "편중";
  return "좋음";
}

function summarize(teams) {
  const activeTeams = teams.filter((team) => (team.rawScore ?? 0) > 0).length;
  const totalRawScore = teams.reduce((sum, team) => sum + (team.rawScore ?? 0), 0);
  const totalAdjustedScore = teams.reduce((sum, team) => sum + (team.adjustedScore ?? team.score ?? 0), 0);
  const totalQualityLabels = teams.reduce((sum, team) => sum + (team.quality?.items?.length ?? 0), 0);
  const qualityWarnings = teams.reduce(
    (sum, team) => sum + (team.quality?.items ?? []).filter((item) => item.severity === "warning" || item.severity === "danger").length,
    0
  );

  return {
    teamCount: teams.length,
    activeTeams,
    averageScore: teams.length ? Math.round(totalAdjustedScore / teams.length) : 0,
    averageAdjustedScore: teams.length ? Math.round(totalAdjustedScore / teams.length) : 0,
    averageRawScore: teams.length ? Math.round(totalRawScore / teams.length) : 0,
    totalRawScore,
    totalCommits: teams.reduce((sum, team) => sum + (team.metrics?.commits ?? 0), 0),
    totalPulls: teams.reduce((sum, team) => sum + (team.metrics?.pulls ?? 0), 0),
    totalMergedPulls: teams.reduce((sum, team) => sum + (team.metrics?.mergedPulls ?? 0), 0),
    qualityLabels: totalQualityLabels,
    qualityWarnings
  };
}

async function githubJson(pathname) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "nxtcloud-ai-workflow-scoreboard"
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const response = await fetch(`https://api.github.com${pathname}`, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status}: ${body.slice(0, 180)}`);
  }
  return response.json();
}

function normalizeSnapshotScores(snapshot) {
  return {
    ...snapshot,
    teams: (snapshot.teams ?? []).map((team) => ({
      ...team,
      adjustedScore: team.adjustedScore ?? team.score ?? 0,
      rawScore: team.rawScore ?? team.score ?? 0
    }))
  };
}

function normalizeCachedTeamForConfig(team, config) {
  return {
    ...team,
    ...config,
    expectedLogins: config.expectedLogins,
    memberAliases: config.memberAliases ?? {}
  };
}

function emptyTeamScore(team) {
  return {
    ...team,
    score: 0,
    rawScore: 0,
    adjustedScore: 0,
    status: "대기",
    refreshedAt: null,
    metrics: {
      commits: 0,
      pulls: 0,
      mergedPulls: 0,
      openPulls: 0,
      peerReviewedPulls: 0,
      mergedPeerReviewedPulls: 0,
      peerReviewCoverage: 0,
      reviews: 0,
      comments: 0,
      riskyFiles: [],
      lastActivityAt: null
    },
    multipliers: { balance: 0, quality: 0, total: 0 },
    components: { rawTotal: 0, prCycle: 0, prFlow: 0, commits: 0, commitPractice: 0, review: 0, peerReview: 0, hygiene: 0 },
    members: (team.expectedLogins ?? []).map((login) => ({ login, points: 0, share: 0, placeholder: false })),
    quality: createEmptyQuality()
  };
}

function readSnapshotFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeSnapshotToDisk(snapshot) {
  fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
}

function dedupeCommits(commits) {
  const seen = new Set();
  return commits.filter((commit) => {
    const id = commit.sha ?? commit.oid;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function getCommitAuthorLogin(commit, expectedLogins, aliases = {}) {
  return normalizeLogin(commit.author?.login ?? commit.commit?.author?.name ?? commit.author?.name, expectedLogins, aliases);
}

function normalizeLogin(login, expectedLogins = [], aliases = {}) {
  if (!login) return null;
  const value = String(login).trim();
  if (aliases[value]) return aliases[value];
  const expected = expectedLogins.find((item) => item.toLowerCase() === value.toLowerCase());
  return expected ?? value;
}

function isExcludedLogin(login) {
  return EXCLUDED_LOGINS.has(String(login ?? "").toLowerCase());
}

function findLastActivityAt({ commits, prDetails }) {
  const dates = [
    ...commits.map((commit) => commit.commit?.committer?.date ?? commit.commit?.author?.date ?? commit.committedDate),
    ...prDetails.map((detail) => detail.pull.updated_at)
  ].filter(Boolean);
  return dates.sort().at(-1) ?? null;
}

function sanitizeError(error) {
  return String(error?.message ?? error ?? "Unknown error").replace(/\s+/g, " ").slice(0, 220);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function roundMultiplier(value) {
  return Math.round(value * 100) / 100;
}
