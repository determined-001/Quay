import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { describe, expect, it } from "vitest";
import {
  UsageError,
  addAnchor,
  buildAnchorRow,
  formatList,
  listAnchors,
  parseArgs,
  setEnabled,
} from "./anchors.mjs";

/** The real `anchors` table, from the migration that creates it, so the CLI's SQL cannot drift from it. */
async function db(): Promise<Client> {
  const client = createClient({ url: "file::memory:" });
  const dir = join(__dirname, "..", "apps", "api", "drizzle");
  const file = readdirSync(dir).filter((f) => f.endsWith(".sql")).find((f) => readFileSync(join(dir, f), "utf8").includes("CREATE TABLE `anchors`"));
  if (!file) throw new Error("no migration creates the anchors table");
  for (const stmt of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint")) {
    if (stmt.trim()) await client.execute(stmt);
  }
  return client;
}

const flags = (argv: string[]) => parseArgs(argv).flags;

describe("scripts/anchors.mjs", () => {
  it("adds an anchor, lists it, and refuses a duplicate", async () => {
    const client = await db();
    const row = buildAnchorRow(
      "Anchor.Example.com",
      flags(["--url", "https://anchor.example.com/", "--corridors", "ngn, kes,NGN", "--protocol", "sep24", "--name", "Example anchor"]),
      1000,
      "anc_test",
    );
    await addAnchor(client, row);

    expect(await listAnchors(client)).toEqual([
      {
        homeDomain: "anchor.example.com",
        displayName: "Example anchor",
        enabled: true,
        protocol: "sep24",
        withdrawType: null,
        corridors: ["NGN", "KES"],
        rateSource: null,
      },
    ]);
    await expect(addAnchor(client, buildAnchorRow("anchor.example.com", flags(["--url", "https://x.example"])))).rejects.toThrow(
      /already in the anchors table/,
    );
  });

  it("stores the base url without a trailing slash and defaults to enabled, auto, any corridor", () => {
    const row = buildAnchorRow("a.example", flags(["--url", "https://a.example///"]));
    expect(row).toMatchObject({ base_url: "https://a.example", enabled: 1, protocol: "auto", corridors: "[]", display_name: "a.example" });
    expect(buildAnchorRow("a.example", flags(["--url", "https://a.example", "--disabled"])).enabled).toBe(0);
  });

  it("disable and enable flip the flag, keep the row, and bump updated_at", async () => {
    const client = await db();
    await addAnchor(client, buildAnchorRow("a.example", flags(["--url", "https://a.example"]), 1, "anc_1"));
    await setEnabled(client, "A.EXAMPLE", false, 50);
    expect((await listAnchors(client))[0]!.enabled).toBe(false);
    expect(Number((await client.execute("SELECT updated_at FROM anchors")).rows[0]!.updated_at)).toBe(50);
    await setEnabled(client, "a.example", true, 60);
    expect((await listAnchors(client))[0]!.enabled).toBe(true);
    await expect(setEnabled(client, "missing.example", false)).rejects.toBeInstanceOf(UsageError);
  });

  it.each([
    [["not a host", "--url", "https://a.example"], /bare host name/],
    [["a.example"], /--url .* is required/],
    [["a.example", "--url", "http://a.example"], /must be https/],
    [["a.example", "--url", "nonsense"], /not a URL/],
    [["a.example", "--url", "https://a.example", "--protocol", "sep31"], /--protocol must be one of/],
    [["a.example", "--url", "https://a.example", "--rate-source", "magic"], /--rate-source must be one of/],
    [["a.example", "--url", "https://a.example", "--corridors", "NGN,N G"], /not a currency code/],
  ])("rejects bad input %j", (argv, message) => {
    const { positionals, flags: f } = parseArgs(argv as string[]);
    expect(() => buildAnchorRow(positionals[0], f)).toThrow(message);
  });

  it("formats the list for an operator", async () => {
    expect(formatList([])).toMatch(/No anchors/);
    const text = formatList([
      { homeDomain: "a.example", displayName: "a", enabled: false, protocol: "auto", withdrawType: "bank_account", corridors: [], rateSource: null },
    ]);
    expect(text).toBe("disabled  a.example  protocol=auto  corridors=any  withdraw_type=bank_account");
  });
});
