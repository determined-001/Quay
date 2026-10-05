import { describe, expect, it } from "vitest";
import type { MiddlewareHandler } from "hono";
import type { StoredOffRampJob } from "@checkout/core";
import { linkRoutes } from "../src/routes/links";
import { generateApiKey, hashApiKey, type ApiKeyScope } from "../src/services/api-keys";
import type { Container } from "../src/services/container";
import { createTestContainer, type TestContainer } from "./setup";

// Issue 4.32: the seller's browser reports the hash of its transfer to the
// anchor. It is stored as a claim; the report verifies it on Horizon.

const HASH = "ab".repeat(32);
const OTHER_HASH = "cd".repeat(32);
const passThrough: MiddlewareHandler = async (_c, next) => next();

function stored(over: Partial<StoredOffRampJob> = {}): StoredOffRampJob {
  return {
    jobId: "wd_1",
    linkId: "lnk_t1",
    anchor: "anchor.example",
    sellerId: null,
    account: null,
    targetCurrency: "NGN",
    targetAmount: "",
    rate: "1000",
    status: "awaiting_transfer",
    externalStatus: null,
    lastError: null,
    transferNotifiedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

async function harness(scopes: ApiKeyScope[] = ["offramp:initiate"], withJob = true) {
  const container = (await createTestContainer()) as TestContainer;
  const app = linkRoutes(container as unknown as Container, passThrough);
  const { plaintext, prefix } = generateApiKey("test");
  await container.apiKeys.create({
    sellerId: container.seller.id,
    name: "transfer-sent key",
    prefix,
    hash: await hashApiKey(plaintext),
    scopes,
  });
  const created = await container.service.createLink(container.seller.id, { title: "T", amount: "10", assetCode: "USDC" });
  const linkId = created.link.id;
  await container.links.save({
    ...created.link,
    status: "offramp_pending",
    offrampJobId: withJob ? "wd_1" : null,
  });
  if (withJob) await container.offrampState.saveJob(stored({ linkId, sellerId: container.seller.id }));
  const post = (body: unknown, key = plaintext, id = linkId) =>
    app.request(`/${id}/cash-out/transfer-sent`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { container, post, key: plaintext };
}

describe("POST /links/:id/cash-out/transfer-sent", () => {
  it("stores the hash (lowercased) on the job as a claim", async () => {
    const { container, post } = await harness();
    const res = await post({ hash: HASH.toUpperCase() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, jobId: "wd_1", hash: HASH });
    expect((await container.offrampState.getJob("wd_1"))?.sellerTxHash).toBe(HASH);
    container.client.close();
  });

  it("is idempotent for the same hash and keeps the first claim when a different one arrives", async () => {
    const { container, post } = await harness();
    expect((await post({ hash: HASH })).status).toBe(200);
    expect((await post({ hash: HASH })).status).toBe(200);
    const second = await post({ hash: OTHER_HASH });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "transfer_already_recorded" });
    expect((await container.offrampState.getJob("wd_1"))?.sellerTxHash).toBe(HASH);
    container.client.close();
  });

  it("rejects anything that is not a 64-character hex hash", async () => {
    const { container, post } = await harness();
    for (const hash of ["", "abc", "z".repeat(64), `${HASH}0`, 5]) {
      expect((await post({ hash })).status).toBe(400);
    }
    expect((await post({})).status).toBe(400);
    container.client.close();
  });

  it("requires auth and the offramp:initiate scope", async () => {
    const { container, post, key } = await harness(["links:read"]);
    expect((await post({ hash: HASH }, "nope")).status).toBe(401);
    expect((await post({ hash: HASH }, key)).status).toBe(403);
    container.client.close();
  });

  it("answers 404 for an unknown link and for another seller's link", async () => {
    const { container, post } = await harness();
    expect((await post({ hash: HASH }, undefined, "lnk_missing")).status).toBe(404);
    const foreign = await container.sellers.createIfAbsent("GFOREIGNSELLERWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    const theirs = await container.service.createLink(foreign.id, { title: "Theirs", amount: "5", assetCode: "USDC" });
    expect((await post({ hash: HASH }, undefined, theirs.link.id)).status).toBe(404);
    container.client.close();
  });

  it("answers 409 when the link has no cash-out job", async () => {
    const { container, post } = await harness(["offramp:initiate"], false);
    const res = await post({ hash: HASH });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "no_cashout_in_progress" });
    container.client.close();
  });
});

describe("DrizzleOffRampStateRepository — reconciliation columns", () => {
  it("round-trips the claimed hash and anchor amounts, and lists jobs by creation range", async () => {
    const { container } = await harness();
    const repo = container.offrampState;
    await repo.saveJob(stored({ jobId: "wd_a", linkId: "l_a", createdAt: 100 }));
    await repo.saveJob(stored({ jobId: "wd_b", linkId: "l_b", createdAt: 200, sellerTxHash: HASH }));
    await repo.saveJob(stored({ jobId: "wd_c", linkId: "l_c", createdAt: 300 }));

    await repo.updateJob("wd_a", { amountIn: "10", amountFee: "0.5", stellarTransactionId: HASH });
    // undefined (a poll that carried no value) leaves the stored one alone.
    await repo.updateJob("wd_a", { amountIn: undefined, status: "settled" });
    expect(await repo.getJob("wd_a")).toMatchObject({
      amountIn: "10",
      amountFee: "0.5",
      stellarTransactionId: HASH,
      sellerTxHash: null,
      status: "settled",
    });

    const inRange = await repo.listJobsCreatedBetween(100, 200);
    expect(inRange.map((j) => j.jobId)).toEqual(["wd_a", "wd_b"]);
    expect(inRange[1]?.sellerTxHash).toBe(HASH);
    container.client.close();
  });
});
