/**
 * UI-only preferences persisted in localStorage. Distinct from agent
 * settings (which live server-side under /settings) — these only affect
 * how the UI behaves in this browser, so we keep them client-local.
 */

const AUTO_GENERATE_SUGGESTIONS_KEY = "northstar.auto_generate_suggestions";

/**
 * Whether goal/story/skill suggestion fetches should fire automatically
 * (debounced) as the user types. When false, the user has to explicitly
 * click "Get suggestions" in the right rail to see anything.
 *
 * Defaults to true — the on-by-default UX matches what shipped before
 * the toggle existed.
 */
export function getAutoGenerateSuggestions(): boolean {
  try {
    const stored = localStorage.getItem(AUTO_GENERATE_SUGGESTIONS_KEY);
    if (stored === null) return true;
    return stored === "1" || stored === "true";
  } catch {
    return true;
  }
}

export function setAutoGenerateSuggestions(value: boolean): void {
  try {
    localStorage.setItem(AUTO_GENERATE_SUGGESTIONS_KEY, value ? "1" : "0");
  } catch {
    // localStorage unavailable — silently fall through.
  }
}
