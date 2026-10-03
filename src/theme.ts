import { THEME_KEY } from "./shared.ts";
import { androidShell } from "./tauri.ts";

export type ThemeChoice = "system" | "light" | "dark";

let choice: ThemeChoice = "system";
try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") choice = stored;
} catch {
    // storage can be unavailable in embedded browsers
}

export const themeChoice = (): ThemeChoice => choice;

export function applyTheme(next: ThemeChoice): void {
    choice = next;
    const light = next === "light" || (next === "system" && matchMedia("(prefers-color-scheme: light)").matches);
    const root = document.documentElement;
    root.dataset["theme"] = light ? "light" : "dark";
    // the Android status and navigation bar icons follow the app's theme, not the system's
    androidShell?.lightBars(light);
    // the browser chrome follows the ground token, so no colour is written twice
    const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
    if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
    try {
        if (next === "system") localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, next);
    } catch {
        // the choice holds for this session when it cannot persist
    }
    window.dispatchEvent(new CustomEvent("mimi:theme"));
}

applyTheme(choice);
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (choice === "system") applyTheme("system");
});
window.addEventListener("storage", (event) => {
    if (event.key !== THEME_KEY && event.key !== null) return;
    applyTheme(event.newValue === "light" || event.newValue === "dark" ? event.newValue : "system");
});
