import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface FixtureSet {
  toml: string;
  sep6Info?: unknown;
  sep12Unauth?: { status: number; statusText: string; body: string };
  metadata: {
    domain: string;
    transferServer?: string;
    kycServer?: string;
    recordedAt: string;
  };
}

export function loadFixtures(domain: string): FixtureSet {
  const dir = resolve(__dirname, `fixtures/${domain}`);
  if (!existsSync(dir)) {
    throw new Error(`No fixture directory found for domain: ${domain}`);
  }

  const toml = readFileSync(resolve(dir, "stellar.toml"), "utf8");
  const metadata = JSON.parse(readFileSync(resolve(dir, "metadata.json"), "utf8"));

  let sep6Info: unknown;
  if (existsSync(resolve(dir, "sep6-info.json"))) {
    sep6Info = JSON.parse(readFileSync(resolve(dir, "sep6-info.json"), "utf8"));
  }

  let sep12Unauth: { status: number; statusText: string; body: string } | undefined;
  if (existsSync(resolve(dir, "sep12-customer-unauth.json"))) {
    sep12Unauth = JSON.parse(readFileSync(resolve(dir, "sep12-customer-unauth.json"), "utf8"));
  }

  return { toml, sep6Info, sep12Unauth, metadata };
}

/**
 * Creates a fetch-compatible stub function that serves recorded fixtures for the given domain.
 * Throws an explicit Error if any URL outside the known fixture set is queried.
 */
export function fixtureFetch(domain: string): typeof fetch {
  const fixtures = loadFixtures(domain);
  const { toml, sep6Info, sep12Unauth, metadata } = fixtures;

  const tomlUrl = `https://${domain}/.well-known/stellar.toml`;
  const infoUrl = metadata.transferServer ? `${metadata.transferServer.replace(/\/+$/, "")}/info` : null;
  const kycUrl = metadata.kycServer ? `${metadata.kycServer.replace(/\/+$/, "")}/customer` : null;

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsedUrl = new URL(urlStr);
    const normalized = `${parsedUrl.origin}${parsedUrl.pathname}`;

    if (normalized === tomlUrl || normalized === `http://${domain}/.well-known/stellar.toml`) {
      return new Response(toml, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (infoUrl && (normalized === infoUrl || urlStr.startsWith(infoUrl))) {
      if (sep6Info) {
        return new Response(JSON.stringify(sep6Info), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }

    if (kycUrl && (normalized === kycUrl || urlStr.startsWith(kycUrl))) {
      if (sep12Unauth) {
        return new Response(sep12Unauth.body, {
          status: sep12Unauth.status,
          statusText: sep12Unauth.statusText,
          headers: { "content-type": "application/json" },
        });
      }
    }

    throw new Error(
      `[fixtureFetch] Unexpected unmocked network request to: ${urlStr} (fixtures loaded for ${domain})`,
    );
  };
}
