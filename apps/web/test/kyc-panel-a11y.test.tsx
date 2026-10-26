// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/components/SessionGate", () => ({ useSellerWallet: () => "GSELLERWALLET" }));
vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => <a href="/privacy">{children as never}</a> }));

import KycPanel from "../app/components/KycPanel";
import type { KycView } from "../lib/api";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const KYC: KycView = {
  status: "NEEDS_INFO",
  requiredFields: [
    { name: "first_name", type: "string", optional: false },
    { name: "birth_date", type: "date", optional: false },
    { name: "id_type", type: "string", optional: false, choices: ["passport", "national_id"] },
    { name: "photo_id_front", type: "binary", optional: false },
    { name: "occupation", type: "string", optional: true },
  ],
  providedFields: {},
  message: null,
  lastSyncedAt: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("KycPanel accessibility (issue 5.27)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let submitFails = false;

  beforeEach(async () => {
    submitFails = false;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/seller/kyc") && init?.method === "PUT") {
        return submitFails
          ? jsonResponse({ error: "kyc_required", missingFields: ["first_name", "id_type", "photo_id_front"] }, 403)
          : jsonResponse({ ...KYC });
      }
      return jsonResponse({ consents: [] });
    }) as unknown as typeof fetch;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<KycPanel kyc={KYC} anchor={null} onUpdated={vi.fn()} onAnchorConnected={vi.fn()} />);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const control = (name: string) => container.querySelector(`#kyc-${name}`) as HTMLElement;

  it("marks required fields (input, select, file) with required and aria-required, and optional ones not", () => {
    for (const n of ["first_name", "birth_date", "id_type", "photo_id_front"]) {
      expect(control(n).getAttribute("aria-required"), n).toBe("true");
      expect(control(n).hasAttribute("required"), n).toBe(true);
    }
    expect(control("occupation").getAttribute("aria-required")).toBe("false");
    expect(control("occupation").hasAttribute("required")).toBe(false);
    // The visual asterisk is decoration, not part of the accessible name.
    expect(container.querySelector('label[for="kyc-first_name"] [aria-hidden="true"]')?.textContent).toContain("*");
  });

  it("shows no Required text and aria-invalid=false before anything is missing", () => {
    expect(container.textContent).not.toContain("Required");
    expect(control("first_name").getAttribute("aria-invalid")).toBe("false");
    expect(control("first_name").hasAttribute("aria-describedby")).toBe(false);
  });

  it("after a kyc_required response, flags each missing field with text, aria-invalid and aria-describedby, and alerts", async () => {
    submitFails = true;
    const submit = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Submit")!;
    await act(async () => {
      submit.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    for (const n of ["first_name", "id_type", "photo_id_front"]) {
      const el = control(n);
      expect(el.getAttribute("aria-invalid"), n).toBe("true");
      const id = el.getAttribute("aria-describedby");
      expect(id, n).toBe(`kyc-${n}-required`);
      const msg = container.querySelector(`#${id}`);
      expect(msg?.textContent, n).toBe("Required");
    }
    // Fields that were not reported missing are untouched.
    expect(control("birth_date").getAttribute("aria-invalid")).toBe("false");
    expect(container.querySelector("#kyc-birth_date-required")).toBeNull();

    const alert = container.querySelector('.err[role="alert"]');
    expect(alert?.textContent).toContain("required fields");
  });
});
