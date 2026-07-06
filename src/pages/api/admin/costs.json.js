import { json, requireAdmin } from "../../../lib/admin-auth.js";
import { getQualityCostSummary } from "../../../lib/quality-evaluator.js";

export async function GET({ cookies }) {
  const unauthorized = requireAdmin(cookies);
  if (unauthorized) return unauthorized;

  return json({ ok: true, costs: await getQualityCostSummary() });
}
