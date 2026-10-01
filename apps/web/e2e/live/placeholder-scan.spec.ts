import { test, expect, request as playwrightRequest } from "@playwright/test";
import { liveApiUrl, liveWebUrl } from "../urls";

/**
 * Placeholder scan over the rendered production HTML (issue 5.7): the last
 * entry's failure mode was mock data on the live surface, and a human sweep
 * is exactly the kind of check that gets skipped under deadline. Fails on any
 * placeholder string a stranger could see.
 *
 * The list is the issue's, verbatim. `TODO` is matched case-sensitively (the
 * word "todo" in prose is not a marker; the SHOUTING form is), the rest
 * case-insensitively. If `Demo Seller` fires, that is the scanner working —
 * it is the literal default of DEFAULT_SELLER_NAME and has leaked before.
 */
const PLACEHOLDERS: { name: string; pattern: RegExp }[] = [
  { name: "Demo Seller", pattern: /demo seller/i },
  { name: "example.com", pattern: /example\.com/i },
  { name: "localhost:8787", pattern: /localhost:8787/i },
  { name: "TODO", pattern: /\bTODO\b/ },
  { name: "lorem", pattern: /\blorem\b/i },
];

async function scan(html: string, where: string): Promise<void> {
  const hits = PLACEHOLDERS.filter(({ pattern }) => pattern.test(html)).map(({ name }) => name);
  expect(hits, `placeholder strings on ${where}: ${hits.join(", ")}`).toEqual([]);
}

test("@live the landing page carries no placeholder strings", async ({ page }) => {
  await page.goto(liveWebUrl());
  await scan(await page.content(), liveWebUrl());
});

test("@live the demo checkout and receipt carry no placeholder strings", async ({ page }) => {
  const api = await playwrightRequest.newContext({ baseURL: liveApiUrl() });
  const demo = (await (await api.get("/demo/link")).json()) as { id: string | null };
  test.skip(!demo.id, "no seeded demo link on this deployment (run pnpm demo:seed)");

  await page.goto(`${liveWebUrl()}/pay/${demo.id}`);
  await scan(await page.content(), `/pay/${demo.id}`);

  const { link } = (await (await api.get(`/links/${demo.id}`)).json()) as {
    link: { status: string; reference: string };
  };
  const settled = new Set(["paid", "offramp_pending", "offramp_settled", "offramp_failed"]);
  if (settled.has(link.status)) {
    await page.goto(`${liveWebUrl()}/r/${link.reference}`);
    await scan(await page.content(), `/r/${link.reference}`);
  }
  await api.dispose();
});
