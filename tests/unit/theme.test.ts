import { describe, expect, it } from "vitest";
import { resolveTheme, themeAttribute } from "@/lib/theme";

describe("theme preference", () => {
  it("uses dark when nothing is saved", () => {
    expect(resolveTheme(null)).toBe("dark");
    expect(themeAttribute("dark")).toBe("spektrace-dark");
  });

  it("keeps a saved light choice and ignores unknown values", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(themeAttribute("light")).toBe("spektrace");
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("system")).toBe("dark");
  });
});
