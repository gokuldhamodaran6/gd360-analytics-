import { Fragment, type ReactNode } from "react";
import { Avatar } from "./Avatar";
import { cn } from "./cn";
import { ChevronRightIcon, SearchIcon } from "./Icons";

// The 56 px top bar (DESIGN_BRIEF.md "App chrome"): breadcrumb on the
// left ("Dashboards / Hotel performance"), and on the right a 240 px
// search field, the page's actions (a "Share" secondary button, one
// primary button) and the avatar. The kit has no router dependency, so a
// crumb with `href` renders a plain <a> unless the app passes `renderLink`
// (src/components/TopNav.tsx passes react-router's Link).

export type BreadcrumbItem = { label: ReactNode; href?: string; onClick?: () => void };

export type BreadcrumbProps = {
  items: BreadcrumbItem[];
  renderLink?: (item: BreadcrumbItem, className: string, children: ReactNode) => ReactNode;
  className?: string;
};

export function Breadcrumb({ items, renderLink, className }: BreadcrumbProps) {
  const linkClass = "ui-focus rounded truncate text-muted transition-colors hover:text-text";
  return (
    <nav aria-label="Breadcrumb" className={cn("flex min-w-0 items-center gap-1.5 text-ui", className)}>
      {items.map((c, i) => {
        const last = i === items.length - 1;
        const isLink = !last && (c.href || c.onClick);
        return (
          <Fragment key={i}>
            {i > 0 && <ChevronRightIcon size={13} className="shrink-0 text-faint" aria-hidden="true" />}
            {isLink ? (
              renderLink && c.href ? (
                renderLink(c, linkClass, c.label)
              ) : c.href ? (
                <a href={c.href} onClick={c.onClick} className={linkClass}>{c.label}</a>
              ) : (
                <button type="button" onClick={c.onClick} className={linkClass}>{c.label}</button>
              )
            ) : (
              <span aria-current={last ? "page" : undefined} className={cn("truncate", last ? "font-semibold text-text" : "text-muted")}>{c.label}</span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

export type TopBarSearchProps = {
  onOpen: () => void;
  label?: string;
  placeholder?: string;
  shortcut?: string;
  className?: string;
};

// The 240 px search affordance: a button that looks like a field and opens
// the command palette (typing happens there, not here).
export function TopBarSearch({ onOpen, label = "Search and jump to anything", placeholder = "Search", shortcut, className }: TopBarSearchProps) {
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "");
  const kbd = shortcut ?? (isMac ? "⌘K" : "Ctrl K");
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={label}
      className={cn(
        "ui-focus flex h-9 w-9 shrink-0 items-center justify-center rounded-ctl border border-border bg-surface text-muted transition-colors hover:border-border-strong hover:bg-subtle hover:text-text",
        "sm:w-[240px] sm:justify-start sm:gap-2 sm:px-2.5",
        className
      )}
    >
      <SearchIcon size={15} />
      <span className="hidden flex-1 text-left text-ui sm:inline">{placeholder}</span>
      {kbd && (
        <kbd className="hidden items-center rounded-[5px] border border-border bg-subtle px-1.5 py-[1px] font-sans text-[10.5px] font-medium text-muted sm:inline-flex">
          {kbd}
        </kbd>
      )}
    </button>
  );
}

export type TopBarProps = {
  breadcrumb?: BreadcrumbItem[];
  renderLink?: BreadcrumbProps["renderLink"];
  // Anything else on the left (a wordmark when there is no breadcrumb, a
  // draft pill).
  leading?: ReactNode;
  // Search slot: pass <TopBarSearch/> or your own control.
  search?: ReactNode;
  // Page actions: "Share", the primary button.
  actions?: ReactNode;
  // Far right: a kit Avatar, or a whole account menu.
  avatar?: ReactNode;
  // Name to render a default Avatar from, when `avatar` is not given.
  userName?: string;
  // Left padding to clear a fixed mobile menu button (AppSidebar's).
  clearMobileMenu?: boolean;
  className?: string;
};

export function TopBar({ breadcrumb, renderLink, leading, search, actions, avatar, userName, clearMobileMenu = false, className }: TopBarProps) {
  return (
    <header className={cn("flex h-topbar min-h-[56px] items-center justify-between gap-3 border-b border-border bg-surface px-4 sm:px-6", className)}>
      <div className={cn("flex min-w-0 flex-1 items-center gap-3", clearMobileMenu && "pl-12 lg:pl-0")}>
        {breadcrumb && breadcrumb.length > 0 && <Breadcrumb items={breadcrumb} renderLink={renderLink} />}
        {leading}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {search}
        {actions}
        {avatar ?? (userName ? <Avatar name={userName} size="md" /> : null)}
      </div>
    </header>
  );
}
