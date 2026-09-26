import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { REDACT_PATHS } from "../src/logger";

describe("KYC log redaction", () => {
  it("redacts literal dotted organization keys at the top level and one level down", () => {
    const lines: string[] = [];
    const logger = pino(
      { redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } },
      { write: (line: string) => lines.push(line) },
    );

    logger.info({
      "organization.name": "Private Merchant Ltd",
      "organization.registration_number": "RC123456",
      tax_id: "123-45-6789",
      id_number: "A1234567",
      birth_date: "1980-01-01",
      nested: { "organization.name": "Nested Merchant Ltd" },
    });

    const logged = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(logged["organization.name"]).toBe("[REDACTED]");
    expect(logged["organization.registration_number"]).toBe("[REDACTED]");
    expect(logged.tax_id).toBe("[REDACTED]");
    expect(logged.id_number).toBe("[REDACTED]");
    expect(logged.birth_date).toBe("[REDACTED]");
    expect((logged.nested as Record<string, unknown>)["organization.name"]).toBe("[REDACTED]");
    expect(lines[0]).not.toContain("Private Merchant Ltd");
  });
});
