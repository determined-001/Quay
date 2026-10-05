import { describe, expect, it } from "vitest";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Logger } from "@checkout/core";
import { AnchorChallengeError, AnchorHttpError, type SellerAnchorAuth } from "@checkout/offramp";
import { linkRoutes } from "../src/routes/links";
import { kycRoutes } from "../src/routes/kyc";
import { anchorAuthRoutes } from "../src/routes/anchor-auth";
import { installErrorHandler } from "../src/error-handler";
import { requestContext } from "../src/request-context";
import { anchorFailure, HttpError } from "../src/services/link-service";
import { generateApiKey, hashApiKey } from "../src/services/api-keys";
import { createTestContainer, type TestContainer } from "./setup";
import type { Container } from "../src/services/container";

/**
 * Issue 4.36: no HTTP response built by apps/api may contain text read from an
 * anchor's response body. Each case makes the (fake) anchor fail with a body
 * holding MARKER and asserts the marker is in the server log but not on the wire.
 */
const MARKER = "SECRET-MARKER";
const anchorBody = `<html><pre>${MARKER} first_name=Ada bank_account_number=1234567890 at /srv/anchor/app.js:42</pre></html>`;
const passThrough: MiddlewareHandler = async (_c, next) => next();

function anchorError(sep: AnchorHttpError["sep"] = "6", op = "withdraw", status = 400): AnchorHttpError {
  return new AnchorHttpError({ sep, op, status, body: anchorBody });
}

/** Captures everything logged so tests can prove the detail went there. */
function captureLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const make = (): Logger => {
    const log = (obj: unknown) => {
      if (typeof obj === "object" && obj !== null) lines.push(obj as Record<string, unknown>);
    };
    return { debug: log, info: log, warn: log, error: log, child: () => make() } as unknown as Logger;
  };
  return { logger: make(), lines };
}

async function expectNoMarker(res: Response): Promise<string> {
  const text = await res.text();
  expect(text).not.toContain(MARKER);
  expect(text).not.toContain("1234567890");
  expect(text).not.toContain("app.js");
  expect(text).not.toContain("<html>");
  return text;
}

describe("link routes: anchor failures", () => {
  async function setup() {
    const container = (await createTestContainer()) as TestContainer;
    const { logger, lines } = captureLogger();
    // The service was built with the default (no-op) logger; give it ours.
    (container.service as unknown as { deps: { logger: Logger } }).deps.logger = logger;
    const app = new Hono();
    app.use("*", requestContext(logger));
    app.route("/links", linkRoutes(container, passThrough));
    const token = await container.tokenFor(container.seller.id, container.seller.wallet);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const created = await app.request("/links", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Anchor error", amount: "10" }),
    });
    const linkId = ((await created.json()) as { link: { id: string } }).link.id;
    const link = await container.links.findById(linkId);
    if (link) {
      link.status = "paid";
      link.txHash = `tx_${linkId}`;
      link.payer = "GBUYER";
      link.paidAmount = "10";
      await container.links.save(link);
    }
    return { container, app, headers, linkId, lines };
  }

  function expectAnchorErrorLog(lines: Record<string, unknown>[], sep = "6", op = "withdraw") {
    const entry = lines.find((l) => l.event === "anchor.error" && l.sep === sep);
    expect(entry).toMatchObject({ event: "anchor.error", sep, op, statusCode: 400 });
    expect(String(entry?.body)).toContain(MARKER);
  }

  it("cash-out: 502 anchor_error with a safe message, detail only in the log", async () => {
    const { container, app, headers, linkId, lines } = await setup();
    container.offramp.quote = async () => {
      throw anchorError();
    };
    const res = await app.request(`/links/${linkId}/cash-out`, {
      method: "POST",
      headers,
      body: JSON.stringify({ targetCurrency: "NGN", payoutFields: {} }),
    });
    expect(res.status).toBe(502);
    await expectNoMarker(res.clone());
    expect(await res.json()).toEqual({
      error: "anchor_error",
      message: "The anchor returned an error (SEP-6 withdraw, HTTP 400).",
    });
    expectAnchorErrorLog(lines);
    container.client.close();
  });

  it("cash-out quote: 502 anchor_error", async () => {
    const { container, app, headers, linkId, lines } = await setup();
    container.offramp.quote = async () => {
      throw anchorError("38", "quote");
    };
    const res = await app.request(`/links/${linkId}/cash-out/quote?targetCurrency=NGN`, { headers });
    expect(res.status).toBe(502);
    await expectNoMarker(res.clone());
    expect(await res.json()).toMatchObject({ error: "anchor_error" });
    expectAnchorErrorLog(lines, "38", "quote");
    container.client.close();
  });

  it("offramp-preview: 502 anchor_error", async () => {
    const { container, app, headers, linkId, lines } = await setup();
    (container.offramp as unknown as { indicativePrices: () => Promise<never> }).indicativePrices = async () => {
      throw anchorError("38", "/prices");
    };
    const res = await app.request(`/links/${linkId}/offramp-preview`, { headers });
    expect(res.status).toBe(502);
    await expectNoMarker(res.clone());
    expect(await res.json()).toMatchObject({ error: "anchor_error" });
    expectAnchorErrorLog(lines, "38", "/prices");
    container.client.close();
  });

  it("offramp-requirements: 502 anchor_error", async () => {
    const { container, app, headers, linkId, lines } = await setup();
    container.offramp.offrampRequirements = async () => {
      throw anchorError("6", "/info");
    };
    const res = await app.request(`/links/${linkId}/offramp-requirements`, { headers });
    expect(res.status).toBe(502);
    await expectNoMarker(res.clone());
    expect(await res.json()).toMatchObject({ error: "anchor_error" });
    expectAnchorErrorLog(lines, "6", "/info");
    container.client.close();
  });

  it("a plain Error (network failure) is also sanitised", async () => {
    const { container, app, headers, linkId } = await setup();
    container.offramp.quote = async () => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED 10.0.0.7:443 ${MARKER}`);
    };
    const res = await app.request(`/links/${linkId}/cash-out/quote?targetCurrency=NGN`, { headers });
    expect(res.status).toBe(502);
    await expectNoMarker(res.clone());
    expect(await res.json()).toMatchObject({ error: "anchor_error" });
    container.client.close();
  });

  it("anchorFailure truncates what it logs for a non-HTTP error", () => {
    const { logger, lines } = captureLogger();
    const failure = anchorFailure(new Error("y".repeat(10_000)), logger);
    expect(failure).toBeInstanceOf(HttpError);
    expect(failure.status).toBe(502);
    expect(String(lines[0]?.error).length).toBeLessThan(2100);
  });
});

describe("/seller/kyc: anchor failures", () => {
  async function setup(fail: () => never) {
    const container = (await createTestContainer()) as TestContainer;
    const { logger, lines } = captureLogger();
    const app = new Hono();
    app.use("*", requestContext(logger));
    app.route(
      "/",
      kycRoutes({
        ...container,
        logger,
        anchorDomain: "testanchor.stellar.org",
        kyc: { status: async () => fail(), submit: async () => fail() },
      } as unknown as Container),
    );
    const { plaintext, prefix } = generateApiKey("test");
    await container.apiKeys.create({
      sellerId: container.seller.id,
      name: "kyc key",
      prefix,
      hash: await hashApiKey(plaintext),
      scopes: ["offramp:initiate"],
    });
    const headers = { authorization: `Bearer ${plaintext}`, "content-type": "application/json" };
    return { container, app, headers, lines };
  }

  it("GET maps an anchor HTTP error to 502 anchor_error", async () => {
    const { container, app, headers, lines } = await setup(() => {
      throw anchorError("12", "customer GET", 500);
    });
    const res = await app.request("/", { headers });
    expect(res.status).toBe(502);
    await expectNoMarker(res.clone());
    expect(await res.json()).toEqual({
      error: "anchor_error",
      message: "The anchor returned an error (SEP-12 customer GET, HTTP 500).",
    });
    expect(lines.some((l) => l.event === "anchor.error" && String(l.body).includes(MARKER))).toBe(true);
    container.client.close();
  });

  it("PUT maps an anchor HTTP error to 502 anchor_error", async () => {
    const { container, app, headers } = await setup(() => {
      throw anchorError("12", "customer PUT", 400);
    });
    const res = await app.request("/", { method: "PUT", headers, body: JSON.stringify({ first_name: "Ada" }) });
    expect(res.status).toBe(502);
    await expectNoMarker(res.clone());
    expect(await res.json()).toMatchObject({ error: "anchor_error" });
    container.client.close();
  });

  it("GET and PUT map a network error to 502 anchor_error", async () => {
    const { container, app, headers } = await setup(() => {
      throw new TypeError(`fetch failed ${MARKER}`);
    });
    const get = await app.request("/", { headers });
    expect(get.status).toBe(502);
    await expectNoMarker(get.clone());
    expect(await get.json()).toMatchObject({ error: "anchor_error" });

    const put = await app.request("/", { method: "PUT", headers, body: JSON.stringify({ first_name: "Ada" }) });
    expect(put.status).toBe(502);
    await expectNoMarker(put.clone());
    container.client.close();
  });

  it("an unexpected error is left for app.onError, which answers JSON 500 with no message", async () => {
    const { container, app, headers } = await setup(() => {
      throw new Error(`bug in adapter ${MARKER}`);
    });
    installErrorHandler(app, captureLogger().logger);
    const res = await app.request("/", { headers });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "internal_error" });
    container.client.close();
  });
});

describe("/seller/anchor-auth: challenge failures", () => {
  async function setup(auth: Partial<SellerAnchorAuth>) {
    const container = await createTestContainer();
    const { logger, lines } = captureLogger();
    const app = new Hono();
    app.use("*", requestContext(logger));
    app.route("/", anchorAuthRoutes({ ...container, logger, anchorAuth: auth } as unknown as Container, passThrough));
    const { plaintext, prefix } = generateApiKey("test");
    await container.apiKeys.create({
      sellerId: container.seller.id,
      name: "anchor auth key",
      prefix,
      hash: await hashApiKey(plaintext),
      scopes: ["offramp:initiate"],
    });
    const headers = { authorization: `Bearer ${plaintext}`, "content-type": "application/json" };
    return { container: container as TestContainer, app, headers, lines };
  }

  it.each([
    ["wrong_network", "The anchor's challenge was built for a different Stellar network."],
    ["wrong_account", "The challenge or token belongs to a different account than your signed-in wallet."],
    ["refused", "The anchor refused the signed challenge."],
  ] as const)("returns fixed text for kind %s, not the error's own message", async (kind, text) => {
    const { container, app, headers, lines } = await setup({
      challenge: async () => {
        throw new AnchorChallengeError(`${MARKER} raw anchor wording`, kind);
      },
      complete: async () => {
        throw new AnchorChallengeError(`${MARKER} raw anchor wording`, kind);
      },
    });
    const challenge = await app.request("/challenge", { method: "POST", headers });
    expect(challenge.status).toBe(502);
    await expectNoMarker(challenge.clone());
    expect(await challenge.json()).toEqual({ error: "challenge_rejected", message: text });

    const complete = await app.request("/", { method: "POST", headers, body: JSON.stringify({ transaction: "AAAA" }) });
    expect(complete.status).toBe(400);
    await expectNoMarker(complete.clone());
    expect(await complete.json()).toEqual({ error: "challenge_rejected", message: text });

    // The real reason is still available to operators.
    expect(lines.some((l) => l.event === "anchor.challenge.rejected" && String(l.reason).includes(MARKER))).toBe(true);
    container.client.close();
  });

  it("maps an anchor HTTP error while fetching the challenge to 502 anchor_error", async () => {
    const { container, app, headers } = await setup({
      challenge: async () => {
        throw anchorError("10", "challenge fetch", 500);
      },
    });
    const res = await app.request("/challenge", { method: "POST", headers });
    expect(res.status).toBe(502);
    await expectNoMarker(res.clone());
    expect(await res.json()).toMatchObject({ error: "anchor_error" });
    container.client.close();
  });
});

describe("installErrorHandler", () => {
  it("answers unhandled errors with JSON 500 and no message or stack, logging the detail", async () => {
    const { logger, lines } = captureLogger();
    const app = new Hono();
    installErrorHandler(app, logger);
    app.get("/boom", () => {
      throw new Error(`kaboom ${MARKER}`);
    });
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "internal_error" });
    expect(text).not.toContain("kaboom");
    expect(lines[0]).toMatchObject({ event: "unhandled.error", path: "/boom" });
    expect(String(lines[0]?.error)).toContain("kaboom");
  });

  it("keeps the response of a deliberate HTTPException", async () => {
    const app = new Hono();
    installErrorHandler(app, captureLogger().logger);
    app.get("/teapot", () => {
      throw new HTTPException(418, { message: "teapot" });
    });
    expect((await app.request("/teapot")).status).toBe(418);
  });
});
