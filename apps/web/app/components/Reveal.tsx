"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Fade-and-lift on first entry into the viewport. IntersectionObserver rather
 * than a scroll listener, so scrolling never triggers layout work. Content is
 * visible by default and only hidden once the client has mounted, so a visitor
 * with JavaScript off, or a crawler, still sees every section.
 */
export default function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"visible" | "armed" | "shown">("visible");

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    // Already on screen at mount (the hero): do not hide it only to show it again.
    const rect = node.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.92) return;

    setState("armed");
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setState("shown");
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`reveal reveal--${state} ${className}`.trim()}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
