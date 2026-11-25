import { describe, it, expect } from "vitest";
import { publicStrings, publicLanguage, buildShellComplianceHtml, buildShellComplianceText, PUBLIC_STRINGS } from "../src/index.js";

describe("public strings (G22)", () => {
  it("matches the language of a locale and falls back to English", () => {
    expect(publicLanguage("es-MX")).toBe("es");
    expect(publicLanguage("de")).toBe("en");
    expect(publicLanguage(null)).toBe("en");
    expect(publicStrings("es").pageUnsubscribeButton).toBe("Darme de baja");
  });
  it("every language has every string", () => {
    const keys = Object.keys(PUBLIC_STRINGS.en!).sort();
    for (const t of Object.values(PUBLIC_STRINGS)) expect(Object.keys(t).sort()).toEqual(keys);
  });
  it("localizes the mail footer, English by default", () => {
    expect(buildShellComplianceHtml("https://x/u", "Addr")).toContain(">Unsubscribe</a> from these emails.");
    expect(buildShellComplianceHtml("https://x/u", "Addr", "es")).toContain(">Darse de baja</a> de estos correos.");
    expect(buildShellComplianceText("https://x/u", "Addr", "es")).toContain("Darse de baja: https://x/u");
  });
});
