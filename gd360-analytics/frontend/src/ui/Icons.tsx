import type { SVGProps } from "react";

// The kit's stroke icon set - the small inline SVGs the dashboard mockups
// (Main/OptionC/System.dc.html) use everywhere. 24-unit viewBox, 1.8 stroke,
// round caps/joins, `currentColor`, no fills, 16 px by default (18 for the
// rail). No icon library: every glyph is ~3 lines and lives here so the
// whole app ships one consistent weight.

export type IconProps = Omit<SVGProps<SVGSVGElement>, "ref"> & {
  size?: number;
  strokeWidth?: number;
};

function Base({ size = 16, strokeWidth = 1.8, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const GridIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </Base>
);

export const ChartIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M3 3v18h18" />
    <path d="M7 15l4-5 3 3 5-7" />
  </Base>
);

export const BarChartIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M3 3v18h18" />
    <rect x="7" y="12" width="3" height="6" rx="0.5" />
    <rect x="13" y="8" width="3" height="10" rx="0.5" />
    <rect x="18" y="5" width="3" height="13" rx="0.5" />
  </Base>
);

export const DatabaseIcon = (p: IconProps) => (
  <Base {...p}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
  </Base>
);

export const SettingsIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Base>
);

export const SearchIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </Base>
);

export const FilterIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M3 5h18l-7 8v5l-4 2v-7z" />
  </Base>
);

export const CalendarIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Base>
);

export const CloseIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M18 6L6 18M6 6l12 12" />
  </Base>
);

// Generic "chevron" with a direction prop, for callers that rotate it.
export const ChevronIcon = ({ direction = "down", ...p }: IconProps & { direction?: "up" | "down" | "left" | "right" }) => {
  const d = direction === "up" ? "M18 15l-6-6-6 6" : direction === "left" ? "M15 18l-6-6 6-6" : direction === "right" ? "M9 18l6-6-6-6" : "M6 9l6 6 6-6";
  return (
    <Base {...p}>
      <path d={d} />
    </Base>
  );
};

export const ChevronDownIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M6 9l6 6 6-6" />
  </Base>
);

export const ChevronUpIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M18 15l-6-6-6 6" />
  </Base>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M15 18l-6-6 6-6" />
  </Base>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 18l6-6-6-6" />
  </Base>
);

export const ChevronsUpDownIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M7 15l5 5 5-5M7 9l5-5 5 5" />
  </Base>
);

export const MoreIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="5" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="19" cy="12" r="1.2" fill="currentColor" />
  </Base>
);

export const DownloadIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3v12M6 11l6 6 6-6" />
    <path d="M4 21h16" />
  </Base>
);

export const ShareIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="18" cy="5" r="2.5" />
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="19" r="2.5" />
    <path d="M8.2 10.8l7.6-4.6M8.2 13.2l7.6 4.6" />
  </Base>
);

export const SparkIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    <path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />
  </Base>
);

// Spec names (DESIGN_BRIEF.md icon list): "sparkle" and "sql".
export const SparkleIcon = SparkIcon;

export const SqlIcon = (p: IconProps) => (
  <Base {...p}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v6c0 1.66 3.58 3 8 3 1.1 0 2.15-.08 3.1-.24" />
    <path d="M4 11v8c0 1.66 3.58 3 8 3 .7 0 1.38-.03 2.03-.1" />
    <path d="M17 15l-3 3 3 3M20 15l3 3-3 3" />
  </Base>
);

export const CheckIcon = (p: IconProps) => (
  <Base strokeWidth={2.2} {...p}>
    <path d="M20 6L9 17l-5-5" />
  </Base>
);

export const WarningIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M10.3 3.9L2.5 17.5A2 2 0 0 0 4.2 20.5h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4M12 17h.01" />
  </Base>
);

export const InfoIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Base>
);

export const CommentIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z" />
  </Base>
);

export const CodeIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />
  </Base>
);

export const PlayIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M7 4l13 8-13 8z" />
  </Base>
);

export const PlusIcon = (p: IconProps) => (
  <Base strokeWidth={2} {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
);

export const MinusIcon = (p: IconProps) => (
  <Base strokeWidth={2} {...p}>
    <path d="M5 12h14" />
  </Base>
);

export const ArrowUpIcon = (p: IconProps) => (
  <Base strokeWidth={2} {...p}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Base>
);

export const ArrowDownIcon = (p: IconProps) => (
  <Base strokeWidth={2} {...p}>
    <path d="M12 5v14M5 12l7 7 7-7" />
  </Base>
);

export const ArrowRightIcon = (p: IconProps) => (
  <Base strokeWidth={2} {...p}>
    <path d="M5 12h14M12 5l7 7-7 7" />
  </Base>
);

export const RefreshIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
    <path d="M21 3v6h-6" />
  </Base>
);

export const TrashIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </Base>
);

export const EditIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Base>
);

export const SaveIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <path d="M17 21v-8H7v8M7 3v5h8" />
  </Base>
);

export const FileIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M6 2h9l5 5v15H6z" />
    <path d="M15 2v5h5" />
  </Base>
);

export const TableIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 10h18M3 15h18M9 4v16" />
  </Base>
);

export const ClockIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </Base>
);

export const UserIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </Base>
);

export const LogoutIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5M21 12H9" />
  </Base>
);

export const ShieldIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3l7 3v5c0 4.5-3 8.2-7 9.5-4-1.3-7-5-7-9.5V6l7-3z" />
  </Base>
);

export const CreditCardIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="2" y="5" width="20" height="14" rx="2.5" />
    <path d="M2 10h20" />
  </Base>
);

export const MenuIcon = (p: IconProps) => (
  <Base strokeWidth={2} {...p}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </Base>
);

export const SunIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </Base>
);

export const MoonIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </Base>
);

export const FlaskIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 3h6M10 3v6.5L4.8 18a1.6 1.6 0 0 0 1.4 2.4h11.6a1.6 1.6 0 0 0 1.4-2.4L14 9.5V3" />
    <path d="M7.5 15h9" />
  </Base>
);

export const NetworkIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="2.5" />
    <circle cx="4.5" cy="6" r="1.6" />
    <circle cx="19.5" cy="6" r="1.6" />
    <circle cx="4.5" cy="18" r="1.6" />
    <circle cx="19.5" cy="18" r="1.6" />
    <path d="M9.9 10.3L6 7.3M14.1 10.3L18 7.3M9.9 13.7L6 16.7M14.1 13.7L18 16.7" />
  </Base>
);

export const ShieldCheckIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3l7 3v5c0 4.5-3 8.2-7 9.5-4-1.3-7-5-7-9.5V6l7-3z" />
    <path d="M9.5 12l1.8 1.8L15 10" />
  </Base>
);

export const ExternalIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  </Base>
);

export const CopyIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Base>
);

export const UserPlusIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M19 8v6M22 11h-6" />
  </Base>
);

export const SidebarIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </Base>
);
