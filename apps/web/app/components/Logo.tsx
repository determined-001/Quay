import Link from "next/link";

/**
 * The Quay mark: a coin sliced on the diagonal, the cut slice slid out to the
 * lower right. Read as a letter it is a Q, and the slid slice is its tail. Read
 * as an object it is value passing straight through: it lands and moves on, and
 * is never held. The body takes the foreground colour and the slice takes the
 * single brand accent, so the mark works on any surface. Plain paths, no ids,
 * so it can repeat on one page. Construction is documented in docs/BRAND.md.
 */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Quay"
      className="logo-mark"
    >
      <path d="M24.85 11.37A10.5 10.5 0 1 0 11.37 24.85ZM9.80 14.20A4.4 4.4 0 1 0 18.60 14.20A4.4 4.4 0 1 0 9.80 14.20Z" fill="currentColor" fillRule="evenodd" />
      <path d="M25.29 12.91A10.5 10.5 0 0 1 12.91 25.29Z" transform="translate(2.12 2.12)" fill="var(--accent)" />
    </svg>
  );
}

export default function Logo({ href = "/", size = 28 }: { href?: string; size?: number }) {
  return (
    <Link href={href} className="logo" aria-label="Quay home">
      <LogoMark size={size} />
      <span className="logo-word">Quay</span>
    </Link>
  );
}
