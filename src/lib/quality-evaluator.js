import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

const QUALITY_ENABLED = process.env.QUALITY_AI_ENABLED === "true";
const AWS_REGION = process.env.AWS_REGION ?? "ap-northeast-2";
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const CACHE_FILE = process.env.QUALITY_CACHE_FILE ?? join(process.cwd(), ".cache", "quality.json");
const COST_FILE = process.env.QUALITY_COST_FILE ?? join(process.cwd(), ".cache", "quality-costs.json");
const INPUT_PRICE_PER_1M_USD = readPrice("BEDROCK_INPUT_PRICE_PER_1M_USD", 1);
const OUTPUT_PRICE_PER_1M_USD = readPrice("BEDROCK_OUTPUT_PRICE_PER_1M_USD", 5);
const MAX_PRS = Number(process.env.QUALITY_MAX_PRS_PER_TEAM ?? 4);
const MAX_COMMITS = Number(process.env.QUALITY_MAX_COMMITS_PER_TEAM ?? 6);

let bedrockClient = null;
let qualityCache = null;
let costCache = null;

export function createEmptyQuality() {
  return {
    enabled: QUALITY_ENABLED,
    provider: "bedrock",
    modelId: MODEL_ID,
    status: "대기",
    summary: "아직 평가할 학생 활동이 없습니다.",
    items: [],
    cached: false,
    evaluatedAt: null,
    error: null
  };
}

export async function evaluateTeamQuality({ team, commits, prDetails }) {
  const recentPullRequests = getRecentPullRequests(prDetails, team);
  const recentCommits = getRecentCommits(commits);

  if (recentPullRequests.length === 0 && recentCommits.length === 0) {
    return createEmptyQuality();
  }

  if (!QUALITY_ENABLED) {
    return {
      ...createEmptyQuality(),
      enabled: false,
      status: "비활성",
      summary: "AI 품질 평가는 서버 설정 후 표시됩니다."
    };
  }

  const activityKey = hashActivity({ teamId: team.id, recentPullRequests, recentCommits });
  const cachedQuality = await readCachedQuality(activityKey);
  if (cachedQuality) return { ...cachedQuality, cached: true };

  try {
    const bedrockResult = await callBedrock({
      team,
      recentPullRequests,
      recentCommits
    });
    const quality = normalizeQuality(bedrockResult.result, activityKey, { recentPullRequests, recentCommits });
    await writeCachedQuality(activityKey, quality);
    await recordQualityCost(activityKey, {
      team,
      usage: bedrockResult.usage
    });
    return quality;
  } catch (error) {
    return {
      ...createEmptyQuality(),
      status: "사람 확인 필요",
      summary: "AI 품질 평가 호출에 실패했습니다. 정량 점수는 계속 표시됩니다.",
      items: [
        {
          type: "system",
          target: "Bedrock",
          label: "사람 확인 필요",
          severity: "warning",
          reason: sanitizeText(error?.message ?? error, 180)
        }
      ],
      evaluatedAt: new Date().toISOString(),
      error: sanitizeText(error?.message ?? error, 220)
    };
  }
}

function getRecentPullRequests(prDetails, team) {
  return [...prDetails]
    .sort((first, second) => new Date(second.pull.updated_at) - new Date(first.pull.updated_at))
    .slice(0, MAX_PRS)
    .map(({ pull, reviews, issueComments, reviewComments, files, pullCommits }) => {
      const peerFeedback = countPeerFeedback({ pull, reviews, issueComments, reviewComments }, team);

      return {
        id: `#${pull.number}`,
        number: pull.number,
        title: sanitizeText(pull.title, 160),
        url: pull.html_url,
        author: pull.user?.login ?? "unknown",
        state: pull.merged_at ? "merged" : pull.state,
        updatedAt: pull.updated_at,
        headSha: pull.head?.sha,
        body: sanitizeText(pull.body, 900),
        files: files.slice(0, 12).map((file) => ({
          filename: file.filename,
          status: file.status,
          changes: file.changes
        })),
        commits: pullCommits.slice(-5).map((commit) => ({
          sha: commit.sha?.slice(0, 7),
          author: commit.author?.login ?? commit.commit?.author?.name ?? "unknown",
          message: sanitizeText(commit.commit?.message?.split("\n")[0], 120)
        })),
        reviewCount: peerFeedback.reviewCount,
        commentCount: peerFeedback.commentCount,
        peerFeedbackAuthors: peerFeedback.authors,
        comments: [...issueComments, ...reviewComments].slice(-6).map((comment) => ({
          author: comment.user?.login ?? "unknown",
          body: sanitizeText(comment.body, 180)
        }))
      };
    });
}

function getRecentCommits(commits) {
  return [...commits]
    .sort((first, second) => {
      const firstDate = first.commit?.author?.date ?? first.commit?.committer?.date ?? "";
      const secondDate = second.commit?.author?.date ?? second.commit?.committer?.date ?? "";
      return new Date(secondDate) - new Date(firstDate);
    })
    .slice(0, MAX_COMMITS)
    .map((commit) => ({
      sha: commit.sha?.slice(0, 7),
      url: commit.html_url,
      author: commit.author?.login ?? commit.commit?.author?.name ?? "unknown",
      date: commit.commit?.author?.date ?? commit.commit?.committer?.date,
      message: sanitizeText(commit.commit?.message?.split("\n")[0], 140)
    }));
}

function countPeerFeedback({ pull, reviews, issueComments, reviewComments }, team) {
  const authors = new Set();
  let reviewCount = 0;
  let commentCount = 0;

  const addPeerFeedback = (login, type) => {
    const reviewer = resolveTeamLogin(login, team);
    const author = resolveTeamLogin(pull.user?.login, team);
    if (!reviewer || !author || reviewer.toLowerCase() === author.toLowerCase()) return;

    authors.add(reviewer);
    if (type === "review") {
      reviewCount += 1;
    } else {
      commentCount += 1;
    }
  };

  reviews.forEach((review) => addPeerFeedback(review.user?.login, "review"));
  issueComments.forEach((comment) => addPeerFeedback(comment.user?.login, "comment"));
  reviewComments.forEach((comment) => addPeerFeedback(comment.user?.login, "comment"));

  return {
    reviewCount,
    commentCount,
    authors: [...authors]
  };
}

function resolveTeamLogin(login, team) {
  const value = String(login ?? "").trim();
  if (!value) return null;

  const aliases = team.memberAliases ?? {};
  const canonicalLogin = aliases[value] ?? aliases[value.toLowerCase()] ?? value;
  const expectedLogins = team.expectedLogins ?? [];
  if (!expectedLogins.length) return canonicalLogin;

  return expectedLogins.find((expectedLogin) => expectedLogin.toLowerCase() === canonicalLogin.toLowerCase()) ?? null;
}

async function callBedrock({ team, recentPullRequests, recentCommits }) {
  const client = getBedrockClient();
  const prompt = buildPrompt({ team, recentPullRequests, recentCommits });
  const command = new ConverseCommand({
    modelId: MODEL_ID,
    messages: [
      {
        role: "user",
        content: [{ text: prompt }]
      }
    ],
    inferenceConfig: {
      maxTokens: 900,
      temperature: 0
    }
  });
  const response = await client.send(command);
  const text = response.output?.message?.content?.find((part) => part.text)?.text ?? "";
  return {
    result: parseJsonFromText(text),
    usage: normalizeBedrockUsage(response.usage)
  };
}

export async function getQualityCostSummary() {
  const cache = await loadCostCache();
  const calls = Object.values(cache.calls ?? {}).sort((first, second) => {
    return new Date(second.evaluatedAt) - new Date(first.evaluatedAt);
  });
  const totals = calls.reduce(
    (sum, call) => ({
      calls: sum.calls + 1,
      inputTokens: sum.inputTokens + call.usage.inputTokens,
      outputTokens: sum.outputTokens + call.usage.outputTokens,
      totalTokens: sum.totalTokens + call.usage.totalTokens,
      estimatedCostUsd: sum.estimatedCostUsd + call.estimatedCostUsd
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 }
  );
  const byTeam = aggregateCostsByTeam(calls);

  return {
    enabled: QUALITY_ENABLED,
    provider: "bedrock",
    modelId: MODEL_ID,
    currency: "USD",
    price: {
      inputPer1M: INPUT_PRICE_PER_1M_USD,
      outputPer1M: OUTPUT_PRICE_PER_1M_USD,
      source: "server-env-or-default"
    },
    updatedAt: cache.updatedAt ?? null,
    totals: roundCostTotals(totals),
    byTeam,
    recentCalls: calls.slice(0, 12)
  };
}

function getBedrockClient() {
  if (!bedrockClient) {
    bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });
  }
  return bedrockClient;
}

function buildPrompt({ team, recentPullRequests, recentCommits }) {
  return `너는 AI 워크플로우 수업용 GitHub PR 협업 대시보드의 품질 보조 평가자다.

목표:
- 점수 자체를 다시 계산하지 않는다.
- 최근 PR과 commit을 보고 사람이 빠르게 확인할 수 있는 품질 라벨을 붙인다.
- 확실하지 않으면 "사람 확인 필요"로 표시한다.
- 단순 반복, 빈 템플릿, 의미 없는 커밋/리뷰는 "더미 의심" 또는 "PR 설명 부족", "리뷰 부족"으로 표시한다.
- 학생이 작은 PR 사이클을 여러 번 연습하는 상황이므로, 변경이 작다는 이유만으로 낮게 보지 않는다.
- PR 작성자가 자기 PR에 남긴 댓글은 동료 리뷰로 보지 않는다.
- reviewCount와 commentCount는 PR 작성자 외 팀원이 남긴 피드백 수다.

허용 라벨:
- 정상
- PR 설명 부족
- 리뷰 부족
- 커밋 메시지 모호
- 더미 의심
- 사람 확인 필요

반드시 JSON만 반환한다. 마크다운 코드블록을 쓰지 않는다.

반환 형식:
{
  "status": "정상 | PR 설명 부족 | 리뷰 부족 | 더미 의심 | 사람 확인 필요",
  "summary": "60자 이내 한국어 요약",
  "items": [
    {
      "type": "pr | commit",
      "target": "#1 또는 커밋 SHA",
      "label": "허용 라벨 중 하나",
      "severity": "good | warning | danger | info",
      "reason": "80자 이내 한국어 근거"
    }
  ]
}

팀:
${team.label} / ${team.repo}

최근 PR:
${JSON.stringify(recentPullRequests, null, 2)}

최근 커밋:
${JSON.stringify(recentCommits, null, 2)}
`;
}

function normalizeQuality(result, activityKey, { recentPullRequests, recentCommits }) {
  const status = normalizeStatus(result?.status);
  const items = Array.isArray(result?.items) ? result.items : [];
  const urlsByTarget = createTargetUrlMap({ recentPullRequests, recentCommits });

  return {
    enabled: true,
    provider: "bedrock",
    modelId: MODEL_ID,
    activityKey,
    status,
    summary: sanitizeText(result?.summary, 120) || "최근 PR/커밋 품질을 자동 검토했습니다.",
    items: items.slice(0, 8).map((item) => ({
      type: item.type === "commit" ? "commit" : item.type === "pr" ? "pr" : "system",
      target: sanitizeText(item.target, 32),
      label: normalizeStatus(item.label),
      severity: normalizeSeverity(item.severity, item.label),
      reason: sanitizeText(item.reason, 140),
      url: urlsByTarget.get(sanitizeText(item.target, 32)) ?? null
    })),
    cached: false,
    evaluatedAt: new Date().toISOString(),
    error: null
  };
}

function createTargetUrlMap({ recentPullRequests, recentCommits }) {
  const urlsByTarget = new Map();
  recentPullRequests.forEach((pull) => urlsByTarget.set(pull.id, pull.url));
  recentCommits.forEach((commit) => urlsByTarget.set(commit.sha, commit.url));
  return urlsByTarget;
}

function normalizeStatus(label) {
  const value = sanitizeText(label, 40);
  const allowed = ["정상", "PR 설명 부족", "리뷰 부족", "커밋 메시지 모호", "더미 의심", "사람 확인 필요"];
  return allowed.includes(value) ? value : "사람 확인 필요";
}

function normalizeSeverity(severity, label) {
  if (["good", "warning", "danger", "info"].includes(severity)) return severity;
  if (label === "정상") return "good";
  if (label === "더미 의심") return "danger";
  if (label === "사람 확인 필요") return "warning";
  return "warning";
}

function hashActivity(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function readCachedQuality(activityKey) {
  const cache = await loadCache();
  return cache[activityKey] ?? null;
}

async function writeCachedQuality(activityKey, quality) {
  const cache = await loadCache();
  cache[activityKey] = quality;
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function loadCache() {
  if (qualityCache) return qualityCache;

  try {
    qualityCache = JSON.parse(await readFile(CACHE_FILE, "utf8"));
  } catch {
    qualityCache = {};
  }

  return qualityCache;
}

async function recordQualityCost(activityKey, { team, usage }) {
  if (!usage.totalTokens) return;

  const cache = await loadCostCache();
  const evaluatedAt = new Date().toISOString();
  cache.calls ??= {};
  cache.calls[activityKey] = {
    activityKey,
    provider: "bedrock",
    modelId: MODEL_ID,
    teamId: team.id,
    teamLabel: team.label,
    repo: team.repo,
    evaluatedAt,
    usage,
    price: {
      inputPer1M: INPUT_PRICE_PER_1M_USD,
      outputPer1M: OUTPUT_PRICE_PER_1M_USD
    },
    estimatedCostUsd: estimateCostUsd(usage)
  };
  cache.updatedAt = evaluatedAt;

  await mkdir(dirname(COST_FILE), { recursive: true });
  await writeFile(COST_FILE, JSON.stringify(cache, null, 2));
}

async function loadCostCache() {
  if (costCache) return costCache;

  try {
    const parsed = JSON.parse(await readFile(COST_FILE, "utf8"));
    costCache = parsed?.calls ? parsed : { calls: {}, updatedAt: parsed?.updatedAt ?? null };
  } catch {
    costCache = { calls: {}, updatedAt: null };
  }

  return costCache;
}

function normalizeBedrockUsage(usage) {
  const inputTokens = readUsageNumber(usage, "inputTokens", "input_tokens");
  const outputTokens = readUsageNumber(usage, "outputTokens", "output_tokens");
  const totalTokens = readUsageNumber(usage, "totalTokens", "total_tokens") || inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
}

function estimateCostUsd(usage) {
  return roundUsd(
    (usage.inputTokens / 1_000_000) * INPUT_PRICE_PER_1M_USD +
      (usage.outputTokens / 1_000_000) * OUTPUT_PRICE_PER_1M_USD
  );
}

function aggregateCostsByTeam(calls) {
  const teams = new Map();

  calls.forEach((call) => {
    const team = teams.get(call.teamId) ?? {
      teamId: call.teamId,
      teamLabel: call.teamLabel,
      repo: call.repo,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      lastEvaluatedAt: null
    };

    team.calls += 1;
    team.inputTokens += call.usage.inputTokens;
    team.outputTokens += call.usage.outputTokens;
    team.totalTokens += call.usage.totalTokens;
    team.estimatedCostUsd += call.estimatedCostUsd;
    team.lastEvaluatedAt = maxIsoDate(team.lastEvaluatedAt, call.evaluatedAt);
    teams.set(call.teamId, team);
  });

  return [...teams.values()]
    .map(roundCostTotals)
    .sort((first, second) => second.estimatedCostUsd - first.estimatedCostUsd);
}

function roundCostTotals(value) {
  return {
    ...value,
    estimatedCostUsd: roundUsd(value.estimatedCostUsd)
  };
}

function readUsageNumber(source, camelKey, snakeKey) {
  const value = source?.[camelKey] ?? source?.[snakeKey] ?? 0;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function readPrice(name, defaultValue) {
  const value = Number(process.env[name] ?? defaultValue);
  return Number.isFinite(value) && value >= 0 ? value : defaultValue;
}

function roundUsd(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function maxIsoDate(first, second) {
  if (!first) return second;
  if (!second) return first;
  return new Date(first) > new Date(second) ? first : second;
}

function parseJsonFromText(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Bedrock response did not contain JSON.");
  }
  return JSON.parse(text.slice(start, end + 1));
}

function sanitizeText(value, maxLength = 300) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
