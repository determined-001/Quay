// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import RegistrationForm from "../app/components/RegistrationForm";
import { api, CheckoutError } from "../lib/api";
import { SEP9_NATURAL_PERSON_FIELDS } from "@checkout/core";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/api", () => {
  return {
    api: {
      getProfile: vi.fn(),
      saveProfile: vi.fn(),
    },
    CheckoutError: class CheckoutError extends Error {
      status: number;
      details: any;
      constructor(code: string, status: number, detail: string, _missing: any, details: any) {
        super(detail);
        this.status = status;
        this.details = details;
      }
    }
  };
});

describe("RegistrationForm", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function type(id: string, value: string) {
    const input = container.querySelector(`[id="${id}"]`) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function submit() {
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  it("renders a field for every non-binary catalogue entry and posts only changed fields", async () => {
    const originalProfile = {
      fields: { family_name: "Smith", given_name: "John" },
      updatedAt: {}
    };

    vi.mocked(api.getProfile).mockResolvedValue(originalProfile);
    vi.mocked(api.saveProfile).mockResolvedValue({ fields: { family_name: "Smith", given_name: "Johnny" }, updatedAt: {} });

    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(RegistrationForm));
    });

    // Expand
    const editBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Edit profile");
    if (editBtn) {
      await act(async () => {
        editBtn.click();
      });
    }

    const nonBinary = SEP9_NATURAL_PERSON_FIELDS.filter(f => f.type !== "binary" && f.name !== "ip_address");
    
    // Check fields are rendered
    nonBinary.forEach(f => {
      const input = container.querySelector(`[id="reg-${f.name}"]`);
      expect(input).toBeTruthy();
    });

    // Modify a field
    await type("reg-given_name", "Johnny");

    // Save
    await submit();

    expect(api.saveProfile).toHaveBeenCalledWith({ given_name: "Johnny" });
    
    root.unmount();
  });

  async function mountExpanded() {
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(RegistrationForm));
    });
    const editBtn = Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Edit profile");
    if (editBtn) await act(async () => { editBtn.click(); });
  }

  it("does not send a cleared field (the API rejects empty values)", async () => {
    vi.mocked(api.getProfile).mockResolvedValue({
      fields: { family_name: "Smith", given_name: "John" },
      updatedAt: {},
    });
    vi.mocked(api.saveProfile).mockResolvedValue({ fields: {}, updatedAt: {} });
    await mountExpanded();
    await type("reg-given_name", "");
    await type("reg-family_name", "Jones");
    await submit();
    expect(api.saveProfile).toHaveBeenCalledWith({ family_name: "Jones" });
    root.unmount();
  });

  it("maps a 422 invalid_fields response onto the offending input", async () => {
    vi.mocked(api.getProfile).mockResolvedValue({ fields: {}, updatedAt: {} });
    vi.mocked(api.saveProfile).mockRejectedValue(
      new CheckoutError("server_error", 422, "invalid_fields", undefined, {
        fields: { given_name: "must be at most 64 characters" },
      }),
    );
    await mountExpanded();
    await type("reg-given_name", "x");
    await submit();
    expect(container.querySelector(`[id="reg-given_name"]`)!.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("must be at most 64 characters");
    root.unmount();
  });

  it("shows an unavailable message when the profile store is not configured (503)", async () => {
    vi.mocked(api.getProfile).mockRejectedValue(new CheckoutError("server_error", 503, "profile_unavailable"));
    await mountExpanded();
    expect(container.textContent).toContain("isn't available on this deployment");
    root.unmount();
  });
});

describe("toProfileView", () => {
  it("maps the API's fields array into value and updatedAt maps", async () => {
    const { toProfileView } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    expect(
      toProfileView({ fields: [{ field: "given_name", value: "Ada", source: "seller", updatedAt: 5 }] }),
    ).toEqual({ fields: { given_name: "Ada" }, updatedAt: { given_name: 5 } });
  });
});
