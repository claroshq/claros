/**
 * Settings layout: persistent section nav on the left, the active
 * sub-page on the right.
 *
 * The nav is grouped by concern (account, the sending engine, what lands
 * in the email itself, workspace) and carries a warning dot on sections
 * the product cannot run without, so "what is missing" is visible from
 * anywhere in settings. Deep-linkable: every section is its own route.
 */
import { NavLink, Outlet } from "react-router-dom";
import {
  User,
  Users,
  Sparkles,
  Mail,
  Gauge,
  Palette,
  MapPin,
  Boxes,
  Tags,
  Activity,
  Webhook,
  FileJson,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "../../components/page-header.js";
import { useSetupState } from "../../settings.js";
import { useProducts } from "../../products.js";
import { cn } from "../../lib/utils.js";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** True when the section needs attention (not configured). */
  warn?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

export default function SettingsLayout() {
  const { llm, transport, tenant } = useSetupState();
  const products = useProducts();

  const groups: NavGroup[] = [
    {
      label: "Account",
      items: [
        { to: "/settings/profile", label: "Profile", icon: User },
        { to: "/settings/team", label: "Team", icon: Users },
      ],
    },
    {
      label: "Engine",
      items: [
        { to: "/settings/llm", label: "AI providers", icon: Sparkles, warn: llm === null },
        { to: "/settings/transport", label: "Transports", icon: Mail, warn: transport === null },
        { to: "/settings/pace", label: "Sending pace", icon: Gauge },
      ],
    },
    {
      label: "Email",
      items: [
        { to: "/settings/topics", label: "Topics", icon: Tags },
        { to: "/settings/branding", label: "Branding", icon: Palette },
        {
          to: "/settings/postal",
          label: "Postal address",
          icon: MapPin,
          warn: tenant !== null && (tenant.postal_address ?? "") === "",
        },
      ],
    },
    {
      label: "Integration",
      items: [
        { to: "/settings/webhooks", label: "Webhooks", icon: Webhook },
        { to: "/settings/config", label: "Config as code", icon: FileJson },
      ],
    },
  ];

  if (products.data?.instance_admin) {
    groups.push({
      label: "Instance",
      items: [
        { to: "/settings/products", label: "Products", icon: Boxes },
        { to: "/settings/health", label: "Health", icon: Activity },
      ],
    });
  }

  return (
    <div className="mx-auto max-w-[90rem]">
      <PageHeader
        eyebrow="Workspace"
        title="Settings"
        subtitle="What this install needs to compile, send, and stay legal."
      />

      <div className="flex flex-col gap-8 lg:flex-row lg:gap-12">
        <nav
          aria-label="Settings sections"
          className="w-full shrink-0 lg:sticky lg:top-8 lg:max-h-[calc(100vh-6rem)] lg:w-60 lg:self-start lg:overflow-y-auto"
        >
          <div className="flex gap-6 overflow-x-auto pb-1 lg:flex-col lg:gap-6 lg:overflow-visible lg:pb-0">
            {groups.map((group) => (
              <div key={group.label} className="shrink-0">
                <p className="mb-2 hidden px-3 text-micro font-semibold uppercase tracking-[0.06em] text-subtle-foreground lg:block">
                  {group.label}
                </p>
                <div className="flex gap-1 lg:flex-col">
                  {group.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      className={({ isActive }) =>
                        cn(
                          "flex h-10 items-center gap-3 whitespace-nowrap rounded-md px-3 text-body transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          isActive
                            ? "bg-selected font-semibold text-foreground"
                            : "font-medium text-muted-foreground hover:bg-card hover:text-foreground",
                        )
                      }
                    >
                      <item.icon size={18} strokeWidth={1.75} className="shrink-0" />
                      {item.label}
                      {item.warn && (
                        <span
                          aria-label="not configured"
                          className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                        />
                      )}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </nav>

        <div className="min-w-0 max-w-3xl flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
