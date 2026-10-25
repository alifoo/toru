import { auth } from "@clerk/nextjs/server";
import { recorderOwnerFor } from "../../../lib/recorder-owner";
const headers = { "Cache-Control": "private, no-store" };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

export async function GET() {
  const { userId } = await auth();
  if (!userId) return fail("authentication_required", 401);
  const recorderUrl = process.env.RECORDER_URL;
  const adminKey = process.env.RECORDER_ADMIN_KEY;
  if (!recorderUrl || !adminKey) return fail("recorder_not_configured", 503);
  try {
    const url = new URL("/admin/recordings", recorderUrl);
    url.searchParams.set("owner", recorderOwnerFor(userId));
    const response = await fetch(url, { headers: { authorization: `Bearer ${adminKey}` },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) return fail("recorder_unavailable", 503);
    const body = await response.json();
    if (!Array.isArray(body?.recordings)) return fail("recorder_unavailable", 503);
    return Response.json({ recordings: body.recordings }, { headers });
  } catch { return fail("recorder_unavailable", 503); }
}
