export function createEmptyQuality(status = "대기") {
  return {
    enabled: false,
    provider: process.env.QUALITY_AI_PROVIDER ?? "none",
    modelId: process.env.QUALITY_MODEL ?? null,
    status,
    summary: "AI 품질 평가는 비활성화되어 있습니다.",
    items: [],
    cached: false,
    evaluatedAt: null,
    error: null
  };
}

export async function evaluateTeamQuality({ commits, prDetails }) {
  const riskyPrs = prDetails.filter(({ files }) => files.some((file) => /(^|\/)(\.env|.*\.pem|.*\.key|.*secret.*|.*token.*)$/i.test(file.filename)));
  const reviewedPrs = prDetails.filter((detail) => countPeerReviewSignals(detail) > 0);
  const recentPrs = prDetails.slice(0, 4);
  const recentCommits = commits.slice(0, 4);

  const items = [
    ...recentPrs.map((detail) => summarizePull(detail)),
    ...recentCommits.map((commit) => summarizeCommit(commit))
  ];

  if (riskyPrs.length > 0) {
    return {
      ...createEmptyQuality("사람 확인 필요"),
      enabled: true,
      summary: "민감 파일로 보이는 변경이 있어 확인이 필요합니다.",
      items,
      evaluatedAt: new Date().toISOString()
    };
  }

  if (prDetails.length > 0 && reviewedPrs.length === 0) {
    return {
      ...createEmptyQuality("리뷰 부족"),
      enabled: true,
      summary: "PR은 있으나 동료 review/comment 기록이 부족합니다.",
      items,
      evaluatedAt: new Date().toISOString()
    };
  }

  return {
    ...createEmptyQuality("정상"),
    enabled: true,
    summary: "최근 PR과 커밋 흐름이 정상 범위입니다.",
    items,
    evaluatedAt: new Date().toISOString()
  };
}

function summarizePull(detail) {
  const reviewSignals = countPeerReviewSignals(detail);
  const additions = detail.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = detail.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const label = reviewSignals > 0 ? "정상" : "리뷰 부족";

  return {
    type: "pr",
    target: `#${detail.pull.number}`,
    label,
    severity: reviewSignals > 0 ? "good" : "warning",
    reason: `${detail.files.length}개 파일, +${additions}/-${deletions}, 동료 신호 ${reviewSignals}건`,
    url: detail.pull.html_url
  };
}

function summarizeCommit(commit) {
  const message = commit.commit?.message?.split("\n")[0] ?? commit.messageHeadline ?? "commit";
  const isClear = /^(feat|fix|docs|style|test|refactor|chore|perf)(\(.+\))?:/i.test(message) || message.length >= 12;

  return {
    type: "commit",
    target: (commit.sha ?? commit.oid ?? "").slice(0, 7),
    label: isClear ? "정상" : "커밋 메시지 모호",
    severity: isClear ? "good" : "warning",
    reason: message,
    url: commit.html_url ?? commit.url ?? null
  };
}

function countPeerReviewSignals(detail) {
  return detail.reviews.length + detail.issueComments.length + detail.reviewComments.length;
}
