export type ThemeChoice = "light" | "dark";

export const THEME_STORAGE_KEY = "spektrace-theme";

export function resolveTheme(saved: string | null): ThemeChoice {
  return saved === "light" ? "light" : "dark";
}

export function themeAttribute(choice: ThemeChoice): "spektrace" | "spektrace-dark" {
  return choice === "dark" ? "spektrace-dark" : "spektrace";
}

/** Keep this string aligned with resolveTheme. It runs before paint. */
export const themeBootScript = `(function(){try{var s=localStorage.getItem("${THEME_STORAGE_KEY}");document.documentElement.setAttribute("data-theme",s==="light"?"spektrace":"spektrace-dark");}catch(e){}})();`;
