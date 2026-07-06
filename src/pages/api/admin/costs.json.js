import { json, requireAdmin } from "../../../lib/admin-auth.js";

export async function GET({ cookies }) {
  const unauthorized = requireAdmin(cookies);
  if (unauthorized) return unauthorized;

  return json({
    ok: true,
    costs: {
      enabled: process.env.QUALITY_AI_ENABLED === "true",
      provider: process.env.QUALITY_AI_PROVIDER ?? "none",
      modelId: process.env.QUALITY_MODEL ?? null,
      totals: {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedUsd: 0
      },
      note: "This recovered source keeps cost reporting admin-only; runtime token accounting is not persisted."
    }
  });
}
