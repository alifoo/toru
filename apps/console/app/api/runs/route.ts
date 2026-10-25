import { auth } from "@clerk/nextjs/server";
import { recorderOwnerFor } from "../../../lib/recorder-owner";
const headers = { "Cache-Control": "private, no-store" };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Demo runs for the signed-in account: the list (newest first), or one run with its recent events (?id=). */
export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) return fail("authentication_required", 401);
  const recorderUrl = process.env.RECORDER_URL, adminKey = process.env.RECORDER_ADMIN_KEY;
  if (!recorderUrl || !adminKey) return fail("recorder_not_configured", 503);
  const params = new URL(request.url).searchParams, id = params.get("id"), before = params.get("before");
  if (id !== null && !uuid.test(id)) return fail("invalid_run_id", 400);
  if (before !== null && !/^[0-9]{1,16}$/.test(before)) return fail("invalid_cursor", 400);
  try {
    const url = new URL(id ? `/admin/runs/${id}` : "/admin/runs", recorderUrl);
    url.searchParams.set("owner", recorderOwnerFor(userId));
    if (!id) { url.searchParams.set("limit", "30"); if (before) url.searchParams.set("before", before); }
    const response = await fetch(url, { headers: { authorization: `Bearer ${adminKey}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) });
    if (response.status === 404 && id) return fail("run_not_found", 404);
    if (!response.ok) return fail("recorder_unavailable", 503);
    const body = await response.json() as Record<string, unknown>;
    if (id) return body.run && typeof body.run === "object" ? Response.json({ run: body.run }, { headers }) : fail("recorder_unavailable", 503);
    if (!Array.isArray(body.runs)) return fail("recorder_unavailable", 503);
    return Response.json({ runs: body.runs, nextBefore: typeof body.nextBefore === "number" ? body.nextBefore : null }, { headers });
  } catch { return fail("recorder_unavailable", 503); }
}
