// Icon set carried over from the legacy vanilla app rail (same SVG paths).
import type { ReactElement } from "react";

function I({ d, filled = false }: { d: string; filled?: boolean }): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

export const Icons = {
  explore: <I d="M12 3 2 9l10 6 10-6-10-6Zm-7 9.5v4L12 21l7-4.5v-4" />,
  search: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </svg>
  ),
  board: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="3" y="4" width="5" height="16" rx="1" />
      <rect x="10" y="4" width="5" height="10" rx="1" />
      <rect x="17" y="4" width="5" height="13" rx="1" />
    </svg>
  ),
  source: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <path d="M6 8.5v7M18 11.5c0 3-4 3-8 4" />
    </svg>
  ),
  executions: <I d="m7 6 6 6-6 6M14 18h6" />,
  cad: <I d="M4 8l8-4 8 4-8 4-8-4Zm0 4 8 4 8-4M4 16l8 4 8-4" />,
  connect: <I d="M9 7H6a4 4 0 0 0 0 8h3M15 7h3a4 4 0 0 1 0 8h-3M8 11h8" />,
};
