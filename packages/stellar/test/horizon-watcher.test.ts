import { describe, expect, it } from "vitest";
import { HorizonWatcher } from "../src/horizon-watcher";
import { FakeHorizonClient } from "./fake-horizon";
import {
  asHorizonRecord,
  strictReceiveFixture,
  strictSendFixture,
} from "./path-payment-fixtures";
import { runWatcherContract } from "./watcher-contract";

runWatcherContract("HorizonWatcher (poll)", () => {
  const fake = new FakeHorizonClient();
  const watcher = new HorizonWatcher(fake);
  // Polling has no persistent connection to drop; fetchSince always reads
  // straight from Horizon, so there's nothing to reconnect.
  return { fake, watcher };
});

describe("HorizonWatcher (poll): path payments", () => {
  it("passes path payment records through unchanged", async () => {
    const fake = new FakeHorizonClient();
    const watcher = new HorizonWatcher(fake);

    fake.addRecord(strictReceiveFixture.to, asHorizonRecord(strictReceiveFixture));
    fake.addRecord(strictSendFixture.to, asHorizonRecord(strictSendFixture));

    const received = await watcher.fetchSince(strictReceiveFixture.to, "");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      txHash: strictReceiveFixture.transaction_hash,
      pagingToken: strictReceiveFixture.paging_token,
      to: strictReceiveFixture.to,
      amount: "0.0000900",
      asset: { code: "XLM", issuer: null },
      sourceAmount: "0.0000007",
      sourceAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    });

    const sent = await watcher.fetchSince(strictSendFixture.to, "");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      txHash: strictSendFixture.transaction_hash,
      to: strictSendFixture.to,
      amount: "40.0000000",
      asset: { code: "MOON", issuer: "GBHQNYHTJGLEJ5JRKGVY3P52FK2MQ4YXAI4CNIMWV5YQTHV6ZDBCWSQ7" },
      sourceAmount: "10.0000000",
      sourceAsset: { code: "IOM", issuer: "GBHQNYHTJGLEJ5JRKGVY3P52FK2MQ4YXAI4CNIMWV5YQTHV6ZDBCWSQ7" },
    });
  });
});
