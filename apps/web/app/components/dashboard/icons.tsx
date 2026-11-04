import type { ReactNode } from "react";

/**
 * Light-line icons drawn for this dashboard: one 1.5 stroke, round caps, a 20
 * unit box. Kept in one file so the weight and corner treatment cannot drift,
 * and so no icon package is needed.
 */
function Svg({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const HomeIcon = () => (
  <Svg>
    <path d="M3.5 9 10 3.5 16.5 9v6.5a1 1 0 0 1-1 1h-3.2v-4.2H7.7v4.2H4.5a1 1 0 0 1-1-1V9Z" />
  </Svg>
);

export const PaymentsIcon = () => (
  <Svg>
    <rect x="3" y="4.5" width="14" height="11" rx="2" />
    <path d="M3 8.5h14M6.5 12.5h3" />
  </Svg>
);

export const CashOutIcon = () => (
  <Svg>
    <path d="M3.5 16.5h13M5 16.5v-6M10 16.5v-6M15 16.5v-6M3.5 9.5 10 4l6.5 5.5" />
  </Svg>
);

export const SettingsIcon = () => (
  <Svg>
    <path d="M4 6h7M14.5 6H16M4 14h2M9.5 14H16" />
    <circle cx="12.5" cy="6" r="1.8" />
    <circle cx="7.5" cy="14" r="1.8" />
  </Svg>
);

export const CodeIcon = () => (
  <Svg>
    <path d="m7.5 6.5-3.5 3.5 3.5 3.5M12.5 6.5 16 10l-3.5 3.5" />
  </Svg>
);

export const PlusIcon = () => (
  <Svg size={16}>
    <path d="M10 4.5v11M4.5 10h11" />
  </Svg>
);

export const CopyIcon = () => (
  <Svg size={16}>
    <rect x="7" y="7" width="9" height="9" rx="2" />
    <path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" />
  </Svg>
);

export const CheckIcon = () => (
  <Svg size={16}>
    <path d="m4.5 10.5 3.5 3.5 7.5-8" />
  </Svg>
);

export const ArrowIcon = () => (
  <Svg size={16}>
    <path d="M5 15 15 5M7.5 5H15v7.5" />
  </Svg>
);

export const CloseIcon = () => (
  <Svg size={18}>
    <path d="m5 5 10 10M15 5 5 15" />
  </Svg>
);

export const ExternalIcon = () => (
  <Svg size={14}>
    <path d="M8 5H5.5A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16h8a1.5 1.5 0 0 0 1.5-1.5V12M11 4h5v5M16 4l-6.5 6.5" />
  </Svg>
);
