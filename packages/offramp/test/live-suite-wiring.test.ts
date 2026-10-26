import { Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { AnchorDiscovery, SellerAnchorAuth } from "../src/anchor-session";
import { TESTANCHOR_BASE_URL, TESTANCHOR_HOME_DOMAIN, TestAnchorOffRamp } from "../src/testanchor";
import { FakeAnchorSessionRepository, FakeOffRampStateRepository } from "./fake-state";

// testanchor.test.ts only runs against the live sandbox (RUN_LIVE_ANCHOR_TESTS),
// which CI skips, so it broke unnoticed once. This builds the adapter exactly
// the way that suite does, offline, so a wiring mistake fails in the ordinary
// test run. The type errors that caused the last break are caught by
// `pnpm typecheck` now that tsconfig.json includes "test".
describe("live anchor suite wiring (issue 8.19)", () => {
  it("constructs TestAnchorOffRamp the way testanchor.test.ts does", () => {
    const discovery = new AnchorDiscovery({
      homeDomain: TESTANCHOR_HOME_DOMAIN,
      fallbackBaseUrl: TESTANCHOR_BASE_URL,
    });
    const sessions = new FakeAnchorSessionRepository();
    const auth = new SellerAnchorAuth({ discovery, sessions, networkPassphrase: Networks.TESTNET });
    const offramp = new TestAnchorOffRamp({
      discovery,
      auth,
      state: new FakeOffRampStateRepository(),
      preferredWithdrawType: process.env.OFFRAMP_TYPE ?? "bank_account",
    });

    expect(offramp.mode).toBe("seller_initiated");
  });

  it("the live suite reads its withdraw type from OFFRAMP_TYPE, defaulting to bank_account", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./testanchor.test.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain('process.env.OFFRAMP_TYPE ?? "bank_account"');
    expect(source).toContain("preferredWithdrawType: LIVE_WITHDRAW_TYPE");
  });
});
