"use client";

import { useEffect, useState, type ReactElement } from "react";

type Pref = "system" | "light" | "dark";

/** localStorage key. Mirrored by the inline script in layout.tsx. */
export const THEME_KEY = "quay-theme";

function readPref(): Pref {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    // Storage can throw in private windows or with site data blocked.
    return "system";
  }
}

function applyPref(pref: Pref): void {
  const root = document.documentElement;
  // "system" removes the attribute so the prefers-color-scheme rule takes over,
  // which also means an OS-level switch updates the page live, with no listener.
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  try {
    if (pref === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, pref);
  } catch {
    // The choice still applies for this page view; it just will not persist.
  }
}

const OPTIONS: { value: Pref; label: string; icon: ReactElement }[] = [
  {
    value: "system",
    label: "Match system",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <rect x="2" y="3" width="12" height="8" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
        <path d="M5.5 13.5h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    value: "light",
    label: "Light",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="2.8" stroke="currentColor" strokeWidth="1.2" />
        <path
          d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path
          d="M13.2 9.4A5.4 5.4 0 0 1 6.6 2.8a5.4 5.4 0 1 0 6.6 6.6Z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
];

/**
 * Three-way theme control: match the system, or force light or dark. A segmented
 * control rather than a single sun/moon button, because "follow my system" is a
 * real third state and hiding it makes the choice sticky by accident.
 */
export default function ThemeToggle() {
  // Starts as "system" on both server and client so hydration matches, then
  // reads the stored choice once mounted.
  const [pref, setPref] = useState<Pref>("system");

  useEffect(() => {
    setPref(readPref());
  }, []);

  function choose(next: Pref) {
    setPref(next);
    applyPref(next);
  }

  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className="theme-toggle__btn"
          aria-pressed={pref === o.value}
          aria-label={o.label}
          title={o.label}
          onClick={() => choose(o.value)}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
