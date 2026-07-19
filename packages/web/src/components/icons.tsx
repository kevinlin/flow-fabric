/* Nav + control glyphs — one consistent line set (24px grid, 1.75 stroke,
   round caps/joins, currentColor). Kept local so the sidebar has a coherent
   icon vocabulary without pulling in a second icon library. */
import type { SVGProps } from 'react';

function Glyph({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Dashboards — a paned overview. */
export function DashboardsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </Glyph>
  );
}

/** Definitions — a BPMN flow: two nodes wired in sequence. */
export function DefinitionsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <rect x="3" y="4" width="7" height="6" rx="1.5" />
      <rect x="14" y="14" width="7" height="6" rx="1.5" />
      <path d="M10 7h3.5a2 2 0 0 1 2 2v5" />
    </Glyph>
  );
}

/** Instances — live activity trace. */
export function InstancesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M3 12h3l2.5-6 4 13 2.5-7H21" />
    </Glyph>
  );
}

/** Inbox — a tray with an intake slot. */
export function InboxIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M4 13l2-8h12l2 8" />
      <path d="M3 13h5l1.5 2.5h5L16 13h5v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Glyph>
  );
}

/** System — settings gear. */
export function SystemIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.5M12 19v2.5M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2.5 12H5M19 12h2.5M4.2 19.8L6 18M18 6l1.8-1.8" />
    </Glyph>
  );
}

/** Chevron — rail collapse/expand affordance (points left when expanded). */
export function ChevronIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M14 6l-6 6 6 6" />
    </Glyph>
  );
}
