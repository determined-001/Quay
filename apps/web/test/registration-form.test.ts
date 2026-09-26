// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import RegistrationForm from "../app/components/RegistrationForm";
import { api } from "../lib/api";
import { SEP9_NATURAL_PERSON_FIELDS } from "@checkout/core";

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
    const givenNameInput = container.querySelector(`[id="reg-given_name"]`) as HTMLInputElement;
    await act(async () => {
      givenNameInput.value = "Johnny";
      givenNameInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Save
    const form = container.querySelector("form");
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(api.saveProfile).toHaveBeenCalledWith({ given_name: "Johnny" });
    
    root.unmount();
  });
});
