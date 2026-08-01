import { describe, expect, it } from "vitest";
import { SessionIssuer } from "../src/services/session";

describe("SessionIssuer", () => {
  it("issues a token that verifies back to the same identity", async () => {
    const issuer = new SessionIssuer("test-secret");
    const token = await issuer.issue({ sub: "GABC123", sellerId: "sel_1" });
    const payload = await issuer.verify(token);
    expect(payload).toEqual({ sub: "GABC123", sellerId: "sel_1" });
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await new SessionIssuer("secret-a").issue({ sub: "GABC123", sellerId: "sel_1" });
    await expect(new SessionIssuer("secret-b").verify(token)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const issuer = new SessionIssuer("test-secret", -1); // already expired
    const token = await issuer.issue({ sub: "GABC123", sellerId: "sel_1" });
    await expect(issuer.verify(token)).rejects.toThrow();
  });
});
