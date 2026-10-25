import { auth } from "@clerk/nextjs/server";
import { brandFromSite } from "../../../../lib/brand-from-site";
const headers = { "Cache-Control": "private, no-store" };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** Prefills a brand from the product's own site: its theme colour, an app icon as the logo, and its name. */
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return fail("origin_forbidden", 403);
  const { userId } = await auth();
  if (!userId) return fail("authentication_required", 401);
  const input = await request.json().catch(() => null) as { url?: unknown } | null;
  if (typeof input?.url !== "string" || !input.url.trim() || input.url.length > 2048) return fail("invalid_url", 400);
  try {
    return Response.json({ suggestion: await brandFromSite(input.url) }, { headers });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "public_https_url_required" || code === "address_not_public" || error instanceof TypeError) return fail("public_https_url_required", 400);
    return fail(code === "site_not_html" ? "site_not_html" : "site_unavailable", 422);
  }
}
