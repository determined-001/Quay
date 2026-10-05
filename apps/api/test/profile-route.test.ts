import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { profileRoutes } from "../src/routes/profile";
import { DrizzleSellerProfileRepository } from "../src/repos/index";
import { generateApiKey, hashApiKey } from "../src/services/api-keys";
import type { Container } from "../src/services/container";
import { createTestContainer } from "./setup";

async function harness(options: { withProfile?: boolean } = {}) {
  const container = await createTestContainer();
  const clock = { now: 1_000 };
  const repo = new DrizzleSellerProfileRepository(container.db, randomBytes(32), () => clock.now);
  const app = profileRoutes({
    ...container,
    sellerProfile: options.withProfile === false ? null : repo,
  } as unknown as Container);

  const seller = container.seller;
  const token = await container.tokenFor(seller.id, seller.wallet);

  const { plaintext, prefix } = generateApiKey("test");
  await container.apiKeys.create({
    sellerId: seller.id,
    name: "profile test key",
    prefix,
    hash: await hashApiKey(plaintext),
    scopes: ["offramp:initiate"],
  });

  const session = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return { app, container, repo, clock, seller, session, apiKey: plaintext };
}

describe("profileRoutes (issue 4.23)", () => {
  it("returns an empty profile before anything is saved", async () => {
    const { app, session, container } = await harness();
    const res = await app.request("/", { headers: session });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fields: [] });
    container.client.close();
  });

  it("stores valid fields and returns names, values, source and updatedAt", async () => {
    const { app, session, container, clock } = await harness();
    clock.now = 4_200;

    const put = await app.request("/", {
      method: "PUT",
      headers: session,
      body: JSON.stringify({ given_name: "Ada", birth_date: "1815-12-10", address_country_code: "GBR" }),
    });
    expect(put.status).toBe(200);

    const get = await app.request("/", { headers: session });
    expect(await get.json()).toEqual({
      fields: [
        { field: "address_country_code", value: "GBR", source: "seller", updatedAt: 4_200 },
        { field: "birth_date", value: "1815-12-10", source: "seller", updatedAt: 4_200 },
        { field: "given_name", value: "Ada", source: "seller", updatedAt: 4_200 },
      ],
    });
    container.client.close();
  });

  it("keeps updatedAt when the same value is saved again", async () => {
    const { app, session, container, clock } = await harness();
    const send = (body: object) =>
      app.request("/", { method: "PUT", headers: session, body: JSON.stringify(body) });

    clock.now = 100;
    await send({ given_name: "Ada" });
    clock.now = 900;
    const res = await send({ given_name: "Ada" });

    expect(((await res.json()) as { fields: { updatedAt: number }[] }).fields[0]!.updatedAt).toBe(100);
    container.client.close();
  });

  it("returns 422 invalid_fields with a reason per field, and stores nothing", async () => {
    const { app, session, container, repo, seller } = await harness();

    const res = await app.request("/", {
      method: "PUT",
      headers: session,
      body: JSON.stringify({
        given_name: "Ada", // valid
        birth_date: "1815-13-40", // bad date
        address_country_code: "UK", // not alpha-3
        email_address: "not-an-email",
        favourite_colour: "green", // not SEP-9
        photo_id_front: "AAAA", // binary
        city: "", // empty
      }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; fields: Record<string, string> };
    expect(body.error).toBe("invalid_fields");
    expect(Object.keys(body.fields).sort()).toEqual([
      "address_country_code",
      "birth_date",
      "city",
      "email_address",
      "favourite_colour",
      "photo_id_front",
    ]);
    expect(body.fields.birth_date).toMatch(/YYYY-MM-DD/);
    expect(body.fields.favourite_colour).toBe("not a SEP-9 field");
    expect(body.fields.photo_id_front).toMatch(/binary/);
    expect(await repo.list(seller.id)).toEqual([]); // the valid field was not written either
    container.client.close();
  });

  it("rejects a body that is not a string map", async () => {
    const { app, session, container } = await harness();
    const res = await app.request("/", { method: "PUT", headers: session, body: JSON.stringify({ city: 5 }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
    container.client.close();
  });

  it("refuses API-key auth on both routes", async () => {
    const { app, apiKey, container, repo, seller } = await harness();
    const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

    const get = await app.request("/", { headers });
    expect(get.status).toBe(403);
    expect(((await get.json()) as { error: string }).error).toBe("forbidden");

    const put = await app.request("/", { method: "PUT", headers, body: JSON.stringify({ given_name: "Ada" }) });
    expect(put.status).toBe(403);
    expect(await repo.list(seller.id)).toEqual([]);
    container.client.close();
  });

  it("refuses an unauthenticated request", async () => {
    const { app, container } = await harness();
    expect((await app.request("/")).status).toBe(401);
    container.client.close();
  });

  it("answers 503 when the deployment has no encrypted profile store", async () => {
    const { app, session, container } = await harness({ withProfile: false });
    const res = await app.request("/", { headers: session });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("profile_unavailable");
    container.client.close();
  });
});
