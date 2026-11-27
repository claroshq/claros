/**
 * ThemeToggle component.
 *
 * A three-way segmented control: light, system, dark. "system" follows the
 * OS and is the default. The choice persists in localStorage via
 * src/lib/theme.ts. Icons are 14px lucide glyphs, same discipline as nav.
 */
import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useThemeMode, type ThemeMode } from "../lib/theme.js";
import { cn } from "@/lib/utils";

const OPTIONS: Array<{ mode: ThemeMode; label: string; icon: React.ElementType }> = [
  { mode: "light", label: "Light theme", icon: Sun },
  { mode: "system", label: "System theme", icon: Monitor },
  { mode: "dark", label: "Dark theme", icon: Moon },
];

export function ThemeToggle({ className }: { className?: string }) {
  const [mode, setMode] = useThemeMode();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md bg-sunken p-0.5",
        className,
      )}
    >
      {OPTIONS.map(({ mode: m, label, icon: Icon }) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          title={label}
          onClick={() => setMode(m)}
          className={cn(
            "flex h-7 w-8 items-center justify-center rounded-sm transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            mode === m
              ? "bg-card text-foreground shadow-card ring-1 ring-border"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
