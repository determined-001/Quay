// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import ThemeToggle, { THEME_KEY } from "../app/components/ThemeToggle";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("ThemeToggle", () => {
  let container: HTMLDivElement;
  let root: Root;

  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const pressed = () =>
    [...container.querySelectorAll("button")]
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.getAttribute("aria-label"));

  async function mount() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<ThemeToggle />));
  }

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("defaults to matching the system and sets no theme attribute", async () => {
    await mount();
    expect(pressed()).toEqual(["Match system"]);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("applies and persists an explicit light choice", async () => {
    await mount();
    await act(async () => button("Light").click());
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("light");
    expect(pressed()).toEqual(["Light"]);
  });

  it("returning to system clears both the attribute and the stored choice", async () => {
    await mount();
    await act(async () => button("Dark").click());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    await act(async () => button("Match system").click());
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    expect(pressed()).toEqual(["Match system"]);
  });

  it("restores a stored choice on mount", async () => {
    window.localStorage.setItem(THEME_KEY, "dark");
    await mount();
    expect(pressed()).toEqual(["Dark"]);
  });

  it("ignores a corrupt stored value rather than applying it", async () => {
    window.localStorage.setItem(THEME_KEY, "purple");
    await mount();
    expect(pressed()).toEqual(["Match system"]);
  });

  it("still switches theme when storage throws", async () => {
    await mount();
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      await act(async () => button("Light").click());
    } finally {
      Storage.prototype.setItem = original;
    }
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(pressed()).toEqual(["Light"]);
  });
});
