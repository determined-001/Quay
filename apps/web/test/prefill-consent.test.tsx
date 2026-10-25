// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PrefillConsent from "../app/components/PrefillConsent";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("PrefillConsent (issue 3.17)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let puts: unknown[];
  let view: unknown;

  async function mount() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<PrefillConsent anchorName="anchor.example" />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  beforeEach(() => {
    puts = [];
    view = { anchorDomain: "anchor.example", available: ["first_name", "last_name"], fields: [], grantedAt: null };
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/seller\/kyc\/prefill-consent$/);
      if (init?.method === "PUT") {
        const { fields } = JSON.parse(String(init.body)) as { fields: string[] };
        puts.push(fields);
        return jsonResponse({ anchorDomain: "anchor.example", available: ["first_name", "last_name"], fields, grantedAt: 1 });
      }
      return jsonResponse(view);
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const boxes = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  const save = () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Save choice")!;

  it("lists only the names on file, all off, and names the anchor", async () => {
    await mount();
    expect(container.querySelector("legend")?.textContent).toBe("Share these with anchor.example to pre-fill its form");
    expect(boxes().map((b) => b.parentElement?.textContent)).toEqual(["First name", "Last name"]);
    expect(boxes().every((b) => !b.checked)).toBe(true);
    expect(save().disabled).toBe(true);
  });

  it("saves exactly the ticked names", async () => {
    await mount();
    await act(async () => {
      boxes()[0]!.click();
    });
    expect(save().disabled).toBe(false);
    await act(async () => {
      save().click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(puts).toEqual([["first_name"]]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved");
    expect(boxes()[0]!.checked).toBe(true);
  });

  it("starts from what was already granted", async () => {
    view = { anchorDomain: "anchor.example", available: ["first_name", "last_name"], fields: ["last_name"], grantedAt: 5 };
    await mount();
    expect(boxes().map((b) => b.checked)).toEqual([false, true]);
  });

  it("renders nothing when no allowlisted value is on file", async () => {
    view = { anchorDomain: "anchor.example", available: [], fields: [], grantedAt: null };
    await mount();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing, and does not throw, when the endpoint is unavailable", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: "anchor_unavailable" }, 404)) as unknown as typeof fetch;
    await mount();
    expect(container.innerHTML).toBe("");
  });
});
