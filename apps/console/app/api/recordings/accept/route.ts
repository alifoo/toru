import { auth } from "@clerk/nextjs/server";
import { recorderOwnerFor } from "../../../../lib/recorder-owner";
const headers = { "Cache-Control": "private, no-store" };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The user decides to receive a video the delivery check held back. It renders again and uses one credit. */
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return fail("origin_forbidden", 403);
  const { userId } = await auth();
  if (!userId) return fail("authentication_required", 401);
  const recorderUrl = process.env.RECORDER_URL, adminKey = process.env.RECORDER_ADMIN_KEY;
  if (!recorderUrl || !adminKey) return fail("recorder_not_configured", 503);
  const input = await request.json().catch(() => null) as { id?: unknown } | null;
  if (typeof input?.id !== "string" || !uuid.test(input.id)) return fail("invalid_recording_id", 400);
  try {
    const response = await fetch(new URL(`/admin/recordings/${input.id}/accept-review`, recorderUrl), {
      method: "POST", headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({ owner: recorderOwnerFor(userId) }), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20000),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 202) return Response.json({ status: body.status ?? "rendering" }, { status: 202, headers });
    if (response.status === 409 || response.status === 404) return fail(typeof body.error === "string" ? body.error : "review_not_pending", response.status);
    return fail("recorder_unavailable", 503);
  } catch { return fail("recorder_unavailable", 503); }
}
