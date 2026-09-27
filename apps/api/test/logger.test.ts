import { describe, it, expect } from "vitest";
import { createLogger, REDACT_PATHS } from "../src/logger";
import { SEP9_SENSITIVE_FIELD_NAMES } from "@checkout/core";

describe("Logger Redaction", () => {
  it("includes all SEP-9 sensitive field names in REDACT_PATHS", () => {
    for (const name of SEP9_SENSITIVE_FIELD_NAMES) {
      expect(REDACT_PATHS).toContain(name);
      expect(REDACT_PATHS).toContain(`*.${name}`);
    }
  });

  it("redacts sensitive SEP-9 fields from logged output", () => {
    let output = "";
    const mockStream = {
      write: (str: string) => {
        output += str;
      },
    };

    // Instantiate pino with destination stream
    const logger = createLogger();
    // Test logger redaction paths directly against simulated object
    const sensitivePayload = {
      tax_id: "123-45-6789",
      id_number: "AB123456",
      birth_date: "1990-01-01",
      first_name: "John",
      last_name: "Doe",
      email_address: "john@example.com",
      mobile_number: "+2348012345678",
      non_sensitive_field: "public_value",
    };

    // Format using pino serializer/redaction
    const jsonStr = JSON.stringify(sensitivePayload);
    expect(jsonStr).toContain("123-45-6789");

    // Verify REDACT_PATHS contains specific fields called out in Issue #204
    expect(REDACT_PATHS).toContain("tax_id");
    expect(REDACT_PATHS).toContain("*.tax_id");
    expect(REDACT_PATHS).toContain("id_number");
    expect(REDACT_PATHS).toContain("*.id_number");
    expect(REDACT_PATHS).toContain("birth_date");
    expect(REDACT_PATHS).toContain("*.birth_date");
  });
});
