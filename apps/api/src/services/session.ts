import { sign, verify } from "hono/jwt";

export interface SessionPayload {
  sub: string; // Stellar G-address — the identity SEP-10 proved control of
  sellerId: string;
}

/** Issues and verifies the session JWT minted after a successful SEP-10 login. */
export class SessionIssuer {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds = 24 * 60 * 60,
  ) {}

  async issue(payload: SessionPayload): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return sign({ ...payload, iat: now, exp: now + this.ttlSeconds }, this.secret, "HS256");
  }

  async verify(token: string): Promise<SessionPayload> {
    const decoded = await verify(token, this.secret, "HS256");
    if (typeof decoded.sub !== "string" || typeof decoded.sellerId !== "string") {
      throw new Error("malformed session token");
    }
    return { sub: decoded.sub, sellerId: decoded.sellerId };
  }
}
