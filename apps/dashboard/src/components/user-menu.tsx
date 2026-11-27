/**
 * User menu: the sidebar footer.
 *
 * One trigger at the bottom of the sidebar (avatar initial, name or email)
 * opens a menu upward with the account's destinations and preferences:
 * Settings, Documentation (claros.org, new tab), the theme (light, system,
 * dark) and Log out. It replaces the footer's separate theme toggle, email
 * line and sign-out button, and Settings' place in the nav.
 *
 * Accessibility follows the product switcher: the trigger is a button with
 * aria-haspopup="menu"; the menu holds menuitem entries and the three theme
 * choices as menuitemradio, with aria-activedescendant (focus stays on the
 * menu). Arrow keys, Home and End move, Enter and Space activate, Escape
 * closes and returns focus to the trigger, Tab and a click outside close.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, BookOpen, ChevronsUpDown, LogOut, Monitor, Moon, Settings, Sun } from "lucide-react";
import { useThemeMode, type ThemeMode } from "../lib/theme.js";
import { useSignOut } from "./use-sign-out.js";
import type { MeResponse } from "../api.js";
import { cn } from "@/lib/utils";

const DOCS_URL = "https://claros.org/docs";

type Item =
  | { kind: "action"; key: string; label: string; icon: React.ElementType; external?: boolean; run: () => void }
  | { kind: "theme"; key: string; label: string; icon: React.ElementType; mode: ThemeMode };

const THEMES: Array<{ mode: ThemeMode; label: string; icon: React.ElementType }> = [
  { mode: "light", label: "Light", icon: Sun },
  { mode: "system", label: "System", icon: Monitor },
  { mode: "dark", label: "Dark", icon: Moon },
];

function initialOf(user: MeResponse["user"]): string {
  const source = (user.name || user.email || "?").trim();
  return source.charAt(0).toUpperCase();
}

export function UserMenu({ me, onNavigate }: { me: MeResponse; onNavigate?: () => void }) {
  const navigate = useNavigate();
  const signOut = useSignOut();
  const [mode, setMode] = useThemeMode();
  const baseId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const items: Item[] = useMemo(
    () => [
      {
        kind: "action",
        key: "settings",
        label: "Settings",
        icon: Settings,
        run: () => {
          navigate("/settings");
          onNavigate?.();
        },
      },
      {
        kind: "action",
        key: "docs",
        label: "Documentation",
        icon: BookOpen,
        external: true,
        run: () => window.open(DOCS_URL, "_blank", "noopener,noreferrer"),
      },
      ...THEMES.map((t): Item => ({ kind: "theme", key: `theme-${t.mode}`, label: t.label, icon: t.icon, mode: t.mode })),
      { kind: "action", key: "logout", label: signOut.pending ? "Logging out..." : "Log out", icon: LogOut, run: signOut.run },
    ],
    [navigate, onNavigate, signOut.pending, signOut.run],
  );

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    panelRef.current?.focus();
    function onPointerDown(e: PointerEvent) {
      if (!panelRef.current?.contains(e.target as Node) && !triggerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function activate(item: Item | undefined) {
    if (!item) return;
    if (item.kind === "theme") {
      setMode(item.mode);
      return; // the menu stays open so the change can be seen
    }
    close(false);
    item.run();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const last = items.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => (i >= last ? 0 : i + 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => (i <= 0 ? last : i - 1));
        return;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        return;
      case "End":
        e.preventDefault();
        setActiveIndex(last);
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        activate(items[activeIndex]);
        return;
      case "Escape":
        e.preventDefault();
        close(true);
        return;
      case "Tab":
        close(false);
        return;
    }
  }

  const display = me.user.name || me.user.email;
  const itemId = (i: number) => `${baseId}-item-${i}`;
  const themeStart = items.findIndex((it) => it.kind === "theme");

  function row(item: Item, i: number) {
    const Icon = item.icon;
    const active = i === activeIndex;
    if (item.kind === "theme") {
      const checked = mode === item.mode;
      return (
        <div
          key={item.key}
          id={itemId(i)}
          role="menuitemradio"
          aria-checked={checked}
          onPointerEnter={() => setActiveIndex(i)}
          onClick={() => activate(item)}
          className={cn(
            "flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-sm text-small transition-colors duration-(--dur-fast)",
            checked ? "bg-card font-medium text-foreground shadow-card ring-1 ring-border" : "text-muted-foreground",
            active && !checked && "bg-card text-foreground",
            active && "outline-2 outline-offset-1 outline-ring",
          )}
        >
          <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
          {item.label}
        </div>
      );
    }
    return (
      <div
        key={item.key}
        id={itemId(i)}
        role="menuitem"
        aria-disabled={item.key === "logout" && signOut.pending ? true : undefined}
        onPointerEnter={() => setActiveIndex(i)}
        onClick={() => activate(item)}
        className={cn(
          "flex h-9 cursor-pointer items-center gap-3 rounded-md px-2.5 text-body text-foreground transition-colors duration-(--dur-fast)",
          active && "bg-sunken dark:bg-hover",
        )}
      >
        <Icon size={16} strokeWidth={1.75} className="shrink-0 text-subtle-foreground" aria-hidden="true" />
        <span className="flex-1">{item.label}</span>
        {item.external && <ArrowUpRight size={14} className="text-subtle-foreground" aria-hidden="true" />}
      </div>
    );
  }

  return (
    <div className="relative">
      {open && (
        <div
          ref={panelRef}
          role="menu"
          tabIndex={-1}
          aria-label="Account"
          aria-activedescendant={itemId(activeIndex)}
          onKeyDown={onKeyDown}
          className="absolute bottom-full left-0 right-0 z-40 mb-2 rounded-lg border border-border bg-card p-1.5 shadow-overlay focus:outline-none"
        >
          <div className="px-2.5 pb-2 pt-1.5">
            <p className="truncate text-body font-medium text-foreground">{display}</p>
            {me.user.name && <p className="truncate text-small text-muted-foreground">{me.user.email}</p>}
          </div>
          <div role="separator" className="my-1 border-t border-border" />
          {items.slice(0, themeStart).map((it, i) => row(it, i))}
          <div role="separator" className="my-1 border-t border-border" />
          <div className="px-2.5 pb-1 pt-1.5 text-micro font-semibold uppercase tracking-[0.06em] text-subtle-foreground">
            Theme
          </div>
          <div role="group" aria-label="Theme" className="mx-1 mb-1 flex gap-0.5 rounded-md bg-sunken p-0.5">
            {items.slice(themeStart, themeStart + THEMES.length).map((it, j) => row(it, themeStart + j))}
          </div>
          <div role="separator" className="my-1 border-t border-border" />
          {items.slice(themeStart + THEMES.length).map((it, j) => row(it, themeStart + THEMES.length + j))}
        </div>
      )}
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        title={me.user.email}
        className={cn(
          "flex h-11 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          open ? "bg-sunken" : "hover:bg-sunken",
        )}
      >
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-caption font-semibold text-accent-text"
        >
          {initialOf(me.user)}
        </span>
        <span className="min-w-0 flex-1 truncate text-body text-foreground">{display}</span>
        <ChevronsUpDown size={14} strokeWidth={1.5} className="shrink-0 text-subtle-foreground" aria-hidden="true" />
      </button>
    </div>
  );
}
