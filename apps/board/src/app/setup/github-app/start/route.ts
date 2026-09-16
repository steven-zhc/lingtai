/**
 * Step 1 of the manifest flow: a page that **auto-submits a POST form** (#169).
 *
 * GitHub takes the manifest as a form body, so this cannot be a link and cannot
 * be a redirect — there is no URL carrying a POST. What is served is one page
 * whose only content is the form, submitted by a line of script as soon as it
 * loads, with a button for a browser that will not run it.
 *
 * It is a route handler rather than a page because what it returns is not a
 * document anybody reads: it exists for the quarter-second between pressing
 * *Create the App on GitHub* and being on GitHub.
 *
 * **The `state` is issued here and checked in `created/route.ts`** — in this
 * process, in memory, which is the whole of what it claims. Nothing is written
 * anywhere on this path: press this, close the tab, and Lingtai has done
 * nothing that needs undoing.
 */
import { creation, offerCreation } from "@lingtai/conductor/create-app";

export const dynamic = "force-dynamic";

/** `"` and `&` in an attribute, `<` for good measure. The manifest carries both. */
function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function POST(request: Request): Promise<Response> {
  // **The same question the page asked**, asked again where the form arrives.
  // The screen not drawing a button is what stops a second App by accident; a
  // route that posts anyway is what would stop one on purpose.
  const offer = await offerCreation();
  if (!offer.offered) {
    return new Response(
      `a GitHub App is already configured${offer.configured?.appId ? ` — app ${offer.configured.appId}` : ""}. ` +
        "Creating a second one would leave an App nothing is installed on. Install this one instead.",
      { status: 409, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const org = String(form.get("org") ?? "").trim();
  const webhook = String(form.get("webhook") ?? "").trim();

  if (name === "") {
    return new Response("the App needs a name — GitHub requires one and it is unique across all of GitHub", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // A `localhost` hook is refused rather than quietly accepted: it produces an
  // App whose deliveries fail silently from the first minute, which is 0016
  // §4's complaint. Inactive is the honest state, and it costs the sweep's
  // latency and nothing else.
  if (webhook !== "" && !/^https:\/\//.test(webhook)) {
    return new Response(
      "a webhook address has to be an https:// URL GitHub can reach. Leave it blank and the hook is " +
        "declared inactive — discovery runs on the daemon's sweep until this board has a public address.",
      { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const origin = new URL(request.url).origin;
  const begun = creation.begin({
    name,
    org: org === "" ? null : org,
    webhookUrl: webhook === "" ? null : webhook,
    // The loopback is accepted by GitHub, which is what makes a local board a
    // place this flow can finish.
    redirectUrl: new URL("/setup/github-app/created", origin).toString(),
  });

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Creating the App on GitHub…</title></head>
<body style="font:14px system-ui;padding:2rem">
<p>Sending the App manifest to GitHub…</p>
<form id="manifest" method="post" action="${attr(begun.action)}">
<input type="hidden" name="manifest" value="${attr(JSON.stringify(begun.manifest))}">
<input type="hidden" name="state" value="${attr(begun.state)}">
<button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById("manifest").submit()</script>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
