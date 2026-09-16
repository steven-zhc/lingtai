/**
 * Steps 3 and 4: GitHub comes back with a code, and it is exchanged (#169).
 *
 * **A route handler and not a page**, because this is where the writing
 * happens: a key file, three lines in an env file and one event. A page that
 * did that in its render would do it again on a refresh, and the refresh would
 * find a code GitHub has already spent. So the work is done once here and the
 * browser is sent to the screen, which reads the outcome the session kept.
 *
 * It answers with the same redirect whatever happened — the outcome, refusal
 * included, is the screen's to say, and there is exactly one place that says
 * it. What this must never do is put any part of the response in a log line or
 * a URL: two of the six values GitHub returns are secrets.
 */
import { creation } from "@lingtai/conductor/create-app";
import { actor } from "@/lib/actor";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  await creation.finish({
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    by: actor(),
  });

  return new Response(null, {
    // 303: whatever this was, what follows is a GET of the screen.
    status: 303,
    headers: { location: new URL("/setup/github-app", url.origin).toString(), "cache-control": "no-store" },
  });
}
