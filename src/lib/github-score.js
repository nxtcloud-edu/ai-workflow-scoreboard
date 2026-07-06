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

let cachedSnapshot = null;
let githubRateLimitedUntil = 0;

const SNAPSHOT_FILE =
  process.env.SCOREBOARD_SNAPSHOT_FILE ?? path.join(process.cwd(), ".cache", "scoreboard-snapshot.json");
const GITHUB_FETCH_MODE = process.env.GITHUB_FETCH_MODE ?? "graphql";
const PR_FETCH_LIMIT = Number(process.env.GITHUB_PR_FETCH_LIMIT ?? 100);
const PR_NESTED_LIMIT = Number(process.env.GITHUB_PR_NESTED_LIMIT ?? 30);
const PR_COMMIT_LIMIT = Number(process.env.GITHUB_PR_COMMIT_LIMIT ?? 20);
const riskFilePattern = /(^|\/)(\.env|id_rsa|.*\.pem|.*\.key|.*secret.*|.*token.*)$/i;

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
  const targetTeams = teamId ? teams.filter((team) => team.id === teamId) : teams;
  const previousSnapshot = getCachedSnapshot();
  if (isGitHubRateLimited()) {
    return previousSnapshot ?? createEmptySnapshot("GitHub API rate limit cooldown");
  }

  const previousTeams = new Map((previousSnapshot?.teams ?? []).map((team) => [team.id, team]));
  const refreshResults = await Promise.all(
    targetTeams.map(async (team) => {
      try {
        return { ok: true, team: await loadTeamScore(team) };
      } catch (error) {
        return { ok: false, team, error: sanitizeError(error) };
      }
    })
  );
  const refreshedMap = new Map(
    refreshResults
      .filter((result) => result.ok)
      .map((result) => [result.team.id, { ...result.team, refreshError: null }])
  );
  const failedMap = new Map(
    refreshResults
      .filter((result) => !result.ok)
      .map((result) => [result.team.id, result.error])
  );

  const mergedTeams = teams.map((team) => {
    const refreshedTeam = refreshedMap.get(team.id);
    if (refreshedTeam) return refreshedTeam;

    const previousTeam = normalizeCachedTeamForConfig(previousTeams.get(team.id) ?? emptyTeamScore(team), team);
    const refreshError = failedMap.get(team.id);
    return refreshError ? markTeamRefreshError(previousTeam, refreshError) : previousTeam;
  });
  cachedSnapshot = {
    refreshedAt: new Date().toISOString(),
    excludedLogins: [...EXCLUDED_LOGINS],
    teams: mergedTeams,
    summary: summarize(mergedTeams),
    error: summarizeRefreshErrors(failedMap)
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

async function loadTeamScore(team) {
  const { commits, prDetails } = await loadTeamActivity(team);
  const scoredCommits = dedupeCommits([...commits, ...prDetails.flatMap((detail) => detail.pullCommits)]).filter(
    (commit) => !isExcludedLogin(getCommitAuthorLogin(commit, team.expectedLogins, team.memberAliases))
  );
  const scoredPrDetails = prDetails.filter(({ pull }) => !isExcludedLogin(pull.user?.login));
  const hasStudentActivity = scoredCommits.length > 0 || scoredPrDetails.length > 0;
  const activity = collectActivity({
    commits: scoredCommits,
    prDetails: scoredPrDetails,
    expectedLogins: team.expectedLogins,
    memberAliases: team.memberAliases
  });
  const peerReviewStats = collectPeerReviewStats(scoredPrDetails, team.expectedLogins, team.memberAliases);
  const quality = await evaluateTeamQuality({ team, commits: scoredCommits, prDetails: scoredPrDetails });
  const balance = calculateBalance(activity.members, team.expectedLogins, team.memberAliases);
  const prCycleScore = calculatePrCycleScore(scoredPrDetails, peerReviewStats);
  const commitPracticeScore = calculateCommitPracticeScore(scoredCommits, team.expectedLogins, team.memberAliases);
  const reviewScore = calculateReviewScore(peerReviewStats);
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
    status: getStatus({ rawScore, adjustedScore, balance }),
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
    quality
  };
}

async function loadTeamActivity(team) {
  if (!process.env.GITHUB_TOKEN || GITHUB_FETCH_MODE === "rest") {
    return loadTeamActivityRest(team);
  }

  try {
    return await loadTeamActivityGraphql(team);
  } catch (error) {
    rememberGitHubRateLimit(error);
    if (GITHUB_FETCH_MODE === "graphql-only" || isRateLimitError(error)) throw error;
    console.warn(`GitHub GraphQL fetch failed for ${team.repo}; falling back to REST`, error);
    return loadTeamActivityRest(team);
  }
}

async function loadTeamActivityRest(team) {
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

      return {
        pull,
        reviews,
        issueComments,
        reviewComments,
        files,
        pullCommits
      };
    })
  );

  return { commits, prDetails };
}

async function loadTeamActivityGraphql(team) {
  const [owner, name] = team.repo.split("/");
  const data = await githubGraphql(
    `query TeamScore($owner: String!, $name: String!, $prLimit: Int!, $nestedLimit: Int!, $commitLimit: Int!) {
      repository(owner: $owner, name: $name) {
        defaultBranchRef {
          target {
            ... on Commit {
              history(first: 100) {
                nodes {
                  oid
                  url
                  messageHeadline
                  committedDate
                  author {
                    name
                    user {
                      login
                    }
                  }
                }
              }
            }
          }
        }
        pullRequests(first: $prLimit, states: [OPEN, CLOSED, MERGED], orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes {
            number
            title
            body
            url
            state
            merged
            mergedAt
            updatedAt
            headRefOid
            author {
              login
            }
            commits(first: $commitLimit) {
              nodes {
                commit {
                  oid
                  url
                  messageHeadline
                  committedDate
                  author {
                    name
                    user {
                      login
                    }
                  }
                }
              }
            }
            reviews(first: $nestedLimit) {
              nodes {
                author {
                  login
                }
                body
                submittedAt
              }
            }
            comments(first: $nestedLimit) {
              nodes {
                author {
                  login
                }
                body
                createdAt
              }
            }
            reviewThreads(first: $nestedLimit) {
              nodes {
                comments(first: $nestedLimit) {
                  nodes {
                    author {
                      login
                    }
                    body
                    createdAt
                  }
                }
              }
            }
            files(first: $nestedLimit) {
              nodes {
                path
                additions
                deletions
              }
            }
          }
        }
      }
    }`,
    {
      owner,
      name,
      prLimit: PR_FETCH_LIMIT,
      nestedLimit: PR_NESTED_LIMIT,
      commitLimit: PR_COMMIT_LIMIT
    }
  );

  const repository = data.repository;
  const commits = (repository.defaultBranchRef?.target?.history?.nodes ?? []).map(mapGraphqlCommit);
  const prDetails = (repository.pullRequests?.nodes ?? []).map((pull) => ({
    pull: mapGraphqlPull(pull),
    reviews: (pull.reviews?.nodes ?? []).map(mapGraphqlReview),
    issueComments: (pull.comments?.nodes ?? []).map(mapGraphqlComment),
    reviewComments: (pull.reviewThreads?.nodes ?? [])
      .flatMap((thread) => thread.comments?.nodes ?? [])
      .map(mapGraphqlComment),
    files: (pull.files?.nodes ?? []).map(mapGraphqlFile),
    pullCommits: (pull.commits?.nodes ?? []).map((node) => mapGraphqlCommit(node.commit))
  }));

  return { commits, prDetails };
}

function mapGraphqlCommit(commit) {
  return {
    sha: commit.oid,
    html_url: commit.url,
    author: commit.author?.user ? { login: commit.author.user.login } : null,
    commit: {
      author: {
        name: commit.author?.name,
        date: commit.committedDate
      },
      committer: {
        date: commit.committedDate
      },
      message: commit.messageHeadline ?? ""
    }
  };
}

function mapGraphqlPull(pull) {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    html_url: pull.url,
    state: pull.state === "OPEN" ? "open" : "closed",
    merged_at: pull.merged ? pull.mergedAt : null,
    updated_at: pull.updatedAt,
    user: pull.author ? { login: pull.author.login } : null,
    head: {
      sha: pull.headRefOid
    }
  };
}

function mapGraphqlReview(review) {
  return {
    user: review.author ? { login: review.author.login } : null,
    body: review.body,
    submitted_at: review.submittedAt
  };
}

function mapGraphqlComment(comment) {
  return {
    user: comment.author ? { login: comment.author.login } : null,
    body: comment.body,
    created_at: comment.createdAt
  };
}

function mapGraphqlFile(file) {
  return {
    filename: file.path,
    status: "changed",
    changes: (file.additions ?? 0) + (file.deletions ?? 0)
  };
}

function dedupeCommits(commits) {
  const commitsBySha = new Map();
  commits.forEach((commit) => {
    const key = commit.sha ?? commit.node_id ?? commit.commit?.tree?.sha;
    if (!key) return;
    commitsBySha.set(key, commit);
  });
  return [...commitsBySha.values()];
}

function emptyTeamScore(team) {
  return {
    ...team,
    score: 0,
    status: "대기",
    refreshedAt: null,
    refreshError: null,
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
    rawScore: 0,
    adjustedScore: 0,
    multipliers: {
      balance: 0,
      quality: 0,
      total: 0
    },
    components: {
      rawTotal: 0,
      balance: 0,
      prCycle: 0,
      prFlow: 0,
      commits: 0,
      commitPractice: 0,
      review: 0,
      peerReview: 0,
      hygiene: 0
    },
    members: createZeroPointMembers(team.expectedLogins),
    quality: createEmptyQuality()
  };
}

function markTeamRefreshError(team, error) {
  return {
    ...team,
    refreshError: error
  };
}

function readSnapshotFromDisk() {
  try {
    cachedSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
    return cachedSnapshot;
  } catch {
    return null;
  }
}

function writeSnapshotToDisk(snapshot) {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
  } catch (error) {
    console.warn("Failed to write scoreboard snapshot", error);
  }
}

function normalizeSnapshotScores(snapshot) {
  const teams = (snapshot.teams ?? []).map(normalizeTeamScore);

  return {
    ...snapshot,
    teams,
    summary: summarize(teams)
  };
}

function normalizeTeamScore(team) {
  const rawScore = team.rawScore ?? 0;
  const hasStudentActivity = rawScore > 0 || (team.metrics?.commits ?? 0) > 0 || (team.metrics?.pulls ?? 0) > 0;
  if (!hasStudentActivity) return team;

  const balanceMultiplier = team.multipliers?.balance ?? 0;
  const qualityMultiplier = calculateQualityMultiplier(team.quality);
  const totalMultiplier = roundMultiplier(balanceMultiplier * qualityMultiplier);
  const adjustedScore = Math.round(rawScore * totalMultiplier);

  return {
    ...team,
    score: adjustedScore,
    adjustedScore,
    status: getStatus({
      rawScore,
      adjustedScore,
      balance: { members: team.members ?? [] }
    }),
    multipliers: {
      ...team.multipliers,
      balance: balanceMultiplier,
      quality: qualityMultiplier,
      total: totalMultiplier
    }
  };
}

function normalizeCachedTeamForConfig(teamScore, teamConfig) {
  const expectedLogins = teamConfig.expectedLogins ?? teamScore.expectedLogins ?? [];
  const memberAliases = {
    ...(teamScore.memberAliases ?? {}),
    ...(teamConfig.memberAliases ?? {})
  };
  const rawScore = teamScore.rawScore ?? 0;
  const hasStudentActivity = rawScore > 0 || (teamScore.metrics?.commits ?? 0) > 0 || (teamScore.metrics?.pulls ?? 0) > 0;
  const balance = calculateBalance(teamScore.members ?? [], expectedLogins, memberAliases);
  const balanceMultiplier = hasStudentActivity ? calculateBalanceMultiplier(balance.score) : 0;
  const qualityMultiplier = hasStudentActivity ? calculateQualityMultiplier(teamScore.quality) : 0;
  const totalMultiplier = roundMultiplier(balanceMultiplier * qualityMultiplier);
  const adjustedScore = Math.round(rawScore * totalMultiplier);

  return {
    ...teamScore,
    expectedLogins,
    expectedMembers: expectedLogins.length,
    memberAliases,
    members: balance.members,
    score: adjustedScore,
    adjustedScore,
    status: getStatus({
      rawScore,
      adjustedScore,
      balance
    }),
    multipliers: {
      ...teamScore.multipliers,
      balance: balanceMultiplier,
      quality: qualityMultiplier,
      total: totalMultiplier
    }
  };
}

function summarizeRefreshErrors(failedMap) {
  if (failedMap.size === 0) return null;

  const failedTeams = [...failedMap.keys()].join(", ");
  return `일부 팀 최신화 실패: ${failedTeams}`;
}

function collectActivity({ commits, prDetails, expectedLogins, memberAliases = {} }) {
  const members = new Map();

  const addPoints = (login, points) => {
    const canonicalLogin = resolveExpectedLoginAlias(login, expectedLogins, memberAliases);
    if (!canonicalLogin || isExcludedLogin(canonicalLogin)) return;
    const member = members.get(canonicalLogin) ?? { login: canonicalLogin, points: 0 };
    member.points += points;
    members.set(canonicalLogin, member);
  };

  commits.forEach((commit) => addPoints(getCommitAuthorLogin(commit, expectedLogins, memberAliases), 1));
  prDetails.forEach(({ pull, reviews, issueComments, reviewComments }) => {
    addPoints(pull.user?.login, pull.merged_at ? 6 : 3);
    reviews.forEach((review) => {
      if (isPeerAction(review.user?.login, pull.user?.login, expectedLogins, memberAliases)) {
        addPoints(review.user?.login, 2);
      }
    });
    issueComments.forEach((comment) => {
      if (isPeerAction(comment.user?.login, pull.user?.login, expectedLogins, memberAliases)) {
        addPoints(comment.user?.login, 1.5);
      }
    });
    reviewComments.forEach((comment) => {
      if (isPeerAction(comment.user?.login, pull.user?.login, expectedLogins, memberAliases)) {
        addPoints(comment.user?.login, 1.5);
      }
    });
  });

  return {
    members: [...members.values()].sort((first, second) => second.points - first.points)
  };
}

function calculateBalance(activeMembers, expectedLogins, memberAliases = {}) {
  const normalizedMembers = new Map();
  activeMembers.forEach((member) => {
    const login = resolveExpectedLoginAlias(member.login, expectedLogins, memberAliases);
    if (!login) return;
    const current = normalizedMembers.get(login.toLowerCase()) ?? { login, points: 0 };
    current.points += member.points;
    normalizedMembers.set(login.toLowerCase(), current);
  });

  const totalPoints = [...normalizedMembers.values()].reduce((sum, member) => sum + member.points, 0);
  const activeMembersByLogin = new Map([...normalizedMembers.values()].map((member) => [member.login.toLowerCase(), member]));
  const expectedMembers = expectedLogins.map((login) => {
    const activeMember = activeMembersByLogin.get(login.toLowerCase());
    activeMembersByLogin.delete(login.toLowerCase());

    return {
      login,
      points: activeMember?.points ?? 0,
      share: totalPoints > 0 ? ((activeMember?.points ?? 0) / totalPoints) * 100 : 0,
      placeholder: false
    };
  });
  const unexpectedMembers = [...activeMembersByLogin.values()].map((member) => ({
    ...member,
    share: totalPoints > 0 ? (member.points / totalPoints) * 100 : 0,
    placeholder: false
  }));
  const visibleMembers = [...expectedMembers, ...unexpectedMembers];
  const expectedShare = 100 / Math.max(1, visibleMembers.length);
  const maxDeviation = (100 - expectedShare) + (visibleMembers.length - 1) * expectedShare;
  const deviation = visibleMembers.reduce((sum, member) => sum + Math.abs(member.share - expectedShare), 0);
  const score = totalPoints === 0 ? 0 : Math.max(0, 15 * (1 - deviation / maxDeviation));

  return {
    score,
    members: visibleMembers.map((member) => ({
      ...member,
      points: Math.round(member.points * 10) / 10,
      share: Math.round(member.share)
    }))
  };
}

function createZeroPointMembers(expectedLogins) {
  return expectedLogins.map((login) => ({
    login,
    points: 0,
    share: 0,
    placeholder: false
  }));
}

function collectPeerReviewStats(prDetails, expectedLogins = [], memberAliases = {}) {
  let reviewCount = 0;
  let commentCount = 0;
  let peerReviewedPulls = 0;
  let mergedPeerReviewedPulls = 0;

  prDetails.forEach(({ pull, reviews, issueComments, reviewComments }) => {
    const peerReviewers = new Set();
    const addPeerAction = (login, type) => {
      const reviewer = resolveScoredTeamLogin(login, expectedLogins, memberAliases);
      const author = resolveScoredTeamLogin(pull.user?.login, expectedLogins, memberAliases);
      if (!reviewer || !author || reviewer.toLowerCase() === author.toLowerCase()) return;

      peerReviewers.add(reviewer.toLowerCase());
      if (type === "review") {
        reviewCount += 1;
      } else {
        commentCount += 1;
      }
    };

    reviews.forEach((review) => addPeerAction(review.user?.login, "review"));
    issueComments.forEach((comment) => addPeerAction(comment.user?.login, "comment"));
    reviewComments.forEach((comment) => addPeerAction(comment.user?.login, "comment"));

    if (peerReviewers.size > 0) {
      peerReviewedPulls += 1;
      if (pull.merged_at) mergedPeerReviewedPulls += 1;
    }
  });

  return {
    reviewCount,
    commentCount,
    peerReviewedPulls,
    mergedPeerReviewedPulls,
    coverage: prDetails.length ? Math.round((peerReviewedPulls / prDetails.length) * 100) : 0
  };
}

function calculateCommitPracticeScore(commits, expectedLogins, memberAliases = {}) {
  if (!expectedLogins.length) return commits.length * 2;

  const commitsByLogin = new Map(expectedLogins.map((login) => [login.toLowerCase(), 0]));

  commits.forEach((commit) => {
    const login = getCommitAuthorLogin(commit, expectedLogins, memberAliases);
    const normalizedLogin = login?.toLowerCase();
    if (!normalizedLogin || !commitsByLogin.has(normalizedLogin)) return;
    commitsByLogin.set(normalizedLogin, commitsByLogin.get(normalizedLogin) + 1);
  });

  const countedCommits = [...commitsByLogin.values()].reduce((sum, count) => sum + count, 0);
  return countedCommits * 2;
}

function calculatePrCycleScore(prDetails, peerReviewStats) {
  const openedScore = prDetails.length * 4;
  const mergedScore = prDetails.filter(({ pull }) => pull.merged_at).length * 6;
  const peerReviewScore = peerReviewStats.peerReviewedPulls * 10;
  return openedScore + mergedScore + peerReviewScore;
}

function calculateReviewScore(peerReviewStats) {
  return peerReviewStats.reviewCount * 10 + peerReviewStats.commentCount * 2;
}

function calculateHygieneScore(prDetails) {
  const riskyFiles = prDetails.flatMap((detail) => detail.files).filter((file) => riskFilePattern.test(file.filename));
  const mergedOrOpen = prDetails.every(({ pull }) => pull.state === "open" || pull.merged_at);
  return (riskyFiles.length === 0 ? 3 : 0) + (mergedOrOpen ? 2 : 0);
}

function calculateBalanceMultiplier(balanceScore) {
  const ratio = Math.max(0, Math.min(1, balanceScore / 15));
  return roundMultiplier(0.7 + ratio * 0.45);
}

function calculateQualityMultiplier(quality, peerReviewStats = null) {
  const studentItems = (quality?.items ?? []).filter((item) => item.type !== "system");
  const coverage = Number(peerReviewStats?.coverage ?? 100);
  const peerReviewCap = coverage <= 0 ? 0.98 : coverage < 30 ? 1 : 1.08;
  if (!studentItems.length) return Math.min(1, peerReviewCap);

  const clampQuality = (value) => roundMultiplier(Math.max(0.9, Math.min(peerReviewCap, value)));

  if (quality?.status === "정상") {
    const adjustment = studentItems.reduce((sum, item) => {
      if (item.severity === "danger") return sum - 0.03;
      if (item.severity === "warning") return sum - 0.015;
      if (item.severity === "good") return sum + 0.005;
      return sum;
    }, 0.02);
    return clampQuality(1 + adjustment);
  }

  const adjustment = studentItems.reduce((sum, item) => {
    if (item.severity === "danger") return sum - 0.03;
    if (item.severity === "warning") return sum - 0.015;
    return sum;
  }, quality?.status === "더미 의심" ? -0.04 : 0);
  return clampQuality(1 + adjustment);
}

function roundMultiplier(value) {
  return Math.round(value * 100) / 100;
}

function findLastActivityAt({ commits, prDetails }) {
  const timestamps = [
    ...commits.map((commit) => commit.commit?.author?.date),
    ...prDetails.map(({ pull }) => pull.updated_at)
  ].filter(Boolean);

  if (timestamps.length === 0) return null;
  return timestamps.sort().at(-1);
}

function getStatus({ rawScore, adjustedScore, balance }) {
  const topMember = balance.members.find((member) => !member.placeholder);
  const inactiveCount = balance.members.filter((member) => member.points === 0).length;

  if (rawScore === 0) return "대기";
  if (topMember?.share >= 70) return "한 명 집중";
  if (inactiveCount > 0) return "참여 공백";
  if (adjustedScore >= 120) return "좋음";
  if (adjustedScore >= 60) return "진행 중";
  return "시작";
}

function isExcludedLogin(login) {
  return EXCLUDED_LOGINS.has((login ?? "").toLowerCase());
}

function isRateLimitError(error) {
  return String(error?.message ?? error).toLowerCase().includes("rate limit");
}

function isGitHubRateLimited() {
  return Date.now() < githubRateLimitedUntil;
}

function rememberGitHubRateLimit(error) {
  if (!isRateLimitError(error)) return;

  const resetAt = Number(error.rateLimitResetAt);
  const fallbackResetAt = Date.now() + 15 * 60 * 1000;
  githubRateLimitedUntil = Math.max(
    githubRateLimitedUntil,
    Number.isFinite(resetAt) && resetAt > Date.now() ? resetAt : fallbackResetAt
  );
}

function isPeerAction(actorLogin, pullAuthorLogin, expectedLogins = [], memberAliases = {}) {
  const actor = resolveScoredTeamLogin(actorLogin, expectedLogins, memberAliases);
  const author = resolveScoredTeamLogin(pullAuthorLogin, expectedLogins, memberAliases);
  return Boolean(actor && author && actor.toLowerCase() !== author.toLowerCase());
}

function resolveScoredTeamLogin(login, expectedLogins = [], memberAliases = {}) {
  const canonicalLogin = resolveExpectedLoginAlias(login, expectedLogins, memberAliases);
  if (!canonicalLogin || isExcludedLogin(canonicalLogin)) return null;
  if (!expectedLogins.length) return canonicalLogin;

  return expectedLogins.some((expectedLogin) => expectedLogin.toLowerCase() === canonicalLogin.toLowerCase())
    ? canonicalLogin
    : null;
}

function getCommitAuthorLogin(commit, expectedLogins = [], memberAliases = {}) {
  const login = commit.author?.login ?? commit.commit?.author?.name;
  return resolveExpectedLoginAlias(login, expectedLogins, memberAliases);
}

function resolveExpectedLoginAlias(login, expectedLogins = [], memberAliases = {}) {
  const value = String(login ?? "").trim();
  if (!value) return value;

  const configuredAlias = memberAliases[value] ?? memberAliases[value.toLowerCase()];
  if (configuredAlias) return configuredAlias;

  const exactMatch = expectedLogins.find((expectedLogin) => expectedLogin.toLowerCase() === value.toLowerCase());
  if (exactMatch) return exactMatch;

  const normalizedValue = normalizeHandle(value);
  if (normalizedValue.length < 4) return value;

  const prefixMatches = expectedLogins.filter((expectedLogin) => {
    const normalizedExpected = normalizeHandle(expectedLogin);
    return normalizedExpected.startsWith(normalizedValue);
  });

  return prefixMatches.length === 1 ? prefixMatches[0] : value;
}

function normalizeHandle(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function summarize(scoredTeams) {
  const activeTeams = scoredTeams.filter((team) => team.metrics.commits > 0 || team.metrics.pulls > 0);
  const averageScore = scoredTeams.length
    ? Math.round(scoredTeams.reduce((sum, team) => sum + team.score, 0) / scoredTeams.length)
    : 0;
  const averageRawScore = scoredTeams.length
    ? Math.round(scoredTeams.reduce((sum, team) => sum + (team.rawScore ?? 0), 0) / scoredTeams.length)
    : 0;
  const totalRawScore = scoredTeams.reduce((sum, team) => sum + (team.rawScore ?? 0), 0);

  return {
    teamCount: scoredTeams.length,
    activeTeams: activeTeams.length,
    averageScore,
    averageAdjustedScore: averageScore,
    averageRawScore,
    totalRawScore,
    totalCommits: scoredTeams.reduce((sum, team) => sum + team.metrics.commits, 0),
    totalPulls: scoredTeams.reduce((sum, team) => sum + team.metrics.pulls, 0),
    totalMergedPulls: scoredTeams.reduce((sum, team) => sum + team.metrics.mergedPulls, 0),
    qualityLabels: scoredTeams.reduce((sum, team) => sum + getStudentQualityItems(team.quality).length, 0),
    qualityWarnings: scoredTeams.reduce(
      (sum, team) => sum + getStudentQualityItems(team.quality).filter((item) => item.severity !== "good").length,
      0
    )
  };
}

function getStudentQualityItems(quality) {
  return (quality?.items ?? []).filter((item) => item.type !== "system");
}

async function githubJson(path) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "nxtcloud-ai-workflow-scoreboard"
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(`https://api.github.com${path}`, { headers });

  if (!response.ok) {
    const body = await response.text();
    throw createGitHubError(`GitHub API ${response.status} ${path}`, body.slice(0, 300), response);
  }

  return response.json();
}

async function githubGraphql(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "nxtcloud-ai-workflow-scoreboard"
    },
    body: JSON.stringify({ query, variables })
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.errors?.length) {
    const errorBody = payload.errors?.map((error) => error.message).join("; ") ?? JSON.stringify(payload).slice(0, 300);
    throw createGitHubError(`GitHub GraphQL ${response.status}`, errorBody, response);
  }

  return payload.data;
}

function createGitHubError(prefix, message, response) {
  const error = new Error(`${prefix}: ${message}`);
  const resetAt = getRateLimitResetAt(response);
  if (String(message).toLowerCase().includes("rate limit") && resetAt) {
    error.rateLimitResetAt = resetAt;
    rememberGitHubRateLimit(error);
  }
  return error;
}

function getRateLimitResetAt(response) {
  const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(resetSeconds) || resetSeconds <= 0) return null;
  return resetSeconds * 1000;
}

function sanitizeError(error) {
  return String(error?.message ?? error ?? "알 수 없는 오류")
    .replace(/\s+/g, " ")
    .slice(0, 280);
}
