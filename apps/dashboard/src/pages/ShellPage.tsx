/**
 * Authenticated shell layout.
 *
 * One chrome column, no top header. The sidebar owns everything persistent:
 * the brand lockup at the top, navigation in the middle, and a footer with
 * the theme toggle, the signed-in user, and sign out. A horizontal header
 * across the content column would spend the scarce axis (vertical space in
 * a data tool) to hold three small controls; the footer puts them where
 * every comparable product puts identity.
 *
 * Multi-product instances: a product switcher sits under the lockup at the
 * top of the sidebar when the user can act on more than one product; its
 * "All products" entry opens the full-screen picker (/products).
 *
 * On mobile (<lg) the sidebar becomes an overlay triggered by a hamburger
 * button in a slim top bar. Tapping a nav link or the backdrop closes it.
 *
 * Navigation is driven by the NAV_ITEMS array. Activating a future
 * destination is a one-line change (set enabled: true and add the route).
 */
import React, { useCallback, useEffect, useState } from "react";
import { Outlet, NavLink, useLocation } from "react-router-dom";
import {
  Home,
  Workflow,
  Activity,
  Users,
  Inbox,
  BookOpen,
  BarChart3,
  Settings,
  Plug,
  LogOut,
  Send,
  Menu,
  X,
} from "lucide-react";
import { BrandLockup } from "../components/brand-lockup.js";
import { ThemeToggle } from "../components/theme-toggle.js";
import { ProductSwitcher } from "../components/product-switcher.js";
import { useSignOut } from "../components/use-sign-out.js";
import type { MeResponse } from "../api.js";

// ---------------------------------------------------------------------------
// Navigation configuration
// ---------------------------------------------------------------------------

interface NavItem {
  label: string;
  path: string;
  icon: React.ElementType;
  /** When false the item renders muted and is not clickable or focusable. */
  enabled: boolean;
}

/**
 * Derived from docs/CLAROS_HANDOFF_V2.md Phase 5 tasks 35-43:
 *   35 - Flows list + detail
 *   37 - Lifecycle Overview
 *   38 - People (CRM)
 *   40 - Approvals
 *   41 - Knowledge Base UI
 *   42 - Analytics
 *   43 - Settings
 *
 * Task 36 (Flow editor) and 39 (Person Detail) are sub-routes, not top-level
 * nav destinations.
 */
const NAV_ITEMS: NavItem[] = [
  { label: "Home", path: "/home", icon: Home, enabled: true },
  { label: "Integrate", path: "/integrate", icon: Plug, enabled: true },
  { label: "Flows", path: "/flows", icon: Workflow, enabled: true },
  { label: "Lifecycle", path: "/lifecycle", icon: Activity, enabled: true },
  { label: "People", path: "/people", icon: Users, enabled: true },
  { label: "Approvals", path: "/approvals", icon: Inbox, enabled: true },
  { label: "Sent Mail", path: "/sent", icon: Send, enabled: true },
  { label: "Knowledge Base", path: "/kb", icon: BookOpen, enabled: true },
  { label: "Analytics", path: "/analytics", icon: BarChart3, enabled: true },
  { label: "Settings", path: "/settings", icon: Settings, enabled: true },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ShellPageProps {
  me: MeResponse;
}

export default function ShellPage({ me }: ShellPageProps) {
  const signOut = useSignOut();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close mobile sidebar on route change.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Prevent body scroll while the mobile sidebar overlay is open.
  useEffect(() => {
    if (sidebarOpen) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [sidebarOpen]);

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  // Shared sidebar content rendered in both desktop and mobile wrappers.
  const sidebarContent = (
    <>
      {/* Brand lockup: mark + Quicksand wordmark. Padding-left matches
          the nav items below (nav px-3 + item px-3 = 24px) so the mark
          and the nav icons share one vertical axis. */}
      <div className="flex h-16 shrink-0 items-center justify-between px-6">
        <BrandLockup markSize={26} />
        {/* Mobile close button */}
        <button
          type="button"
          onClick={closeSidebar}
          aria-label="Close menu"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--dur-fast) hover:bg-secondary hover:text-foreground lg:hidden"
        >
          <X size={20} strokeWidth={1.5} />
        </button>
      </div>

      {/* Product switcher: only when the user can act on several products */}
      <ProductSwitcher currentProductId={me.user.tenantId} />

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;

          if (!item.enabled) {
            return (
              <span
                key={item.path}
                aria-disabled="true"
                className="flex items-center gap-3 rounded-md px-3 py-2 text-[14px] text-subtle-foreground select-none"
              >
                <Icon size={16} strokeWidth={1.75} />
                {item.label}
              </span>
            );
          }

          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                [
                  "flex items-center gap-3 rounded-md px-3 py-2 text-[14px] transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive
                    ? "bg-selected font-semibold text-foreground"
                    : "font-medium text-muted-foreground hover:bg-sunken hover:text-foreground",
                ].join(" ")
              }
            >
              <Icon size={16} strokeWidth={1.75} />
              {item.label}
            </NavLink>
          );
        })}
      </nav>

      {/* Footer: appearance, identity, session */}
      <div className="shrink-0 border-t border-border px-3 py-3">
        <div className="flex items-center justify-between px-1 pb-2">
          <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            Theme
          </span>
          <ThemeToggle />
        </div>
        <div className="flex items-center gap-1 rounded-md px-1 py-1">
          <span
            className="min-w-0 flex-1 truncate text-[14px] text-muted-foreground"
            title={me.user.email}
          >
            {me.user.email}
          </span>
          <button
            type="button"
            onClick={signOut.run}
            disabled={signOut.pending}
            title={signOut.pending ? "Signing out..." : "Sign out"}
            aria-label="Sign out"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--dur-fast) hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:text-subtle-foreground"
          >
            <LogOut size={16} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      {/* Desktop sidebar: always visible at lg+ */}
      <aside className="hidden w-60 flex-col bg-sunken lg:flex">
        {sidebarContent}
      </aside>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-foreground/20"
            onClick={closeSidebar}
            aria-hidden="true"
          />
          {/* Sidebar panel */}
          <aside className="relative flex w-72 max-w-[85vw] flex-col bg-sunken shadow-overlay">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Content column */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile top bar: visible below lg */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4 lg:hidden">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            className="flex h-9 w-9 items-center justify-center rounded-md text-foreground transition-colors duration-(--dur-fast) hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Menu size={20} strokeWidth={1.5} />
          </button>
          <BrandLockup markSize={22} />
        </header>

        <main className="flex-1 min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-6 sm:px-6 sm:py-7 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
