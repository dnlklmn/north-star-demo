/**
 * Eval-run defaults stored in localStorage. Used by both the Settings panel
 * (where the user picks defaults) and the EvaluatePanel (where they're read
 * to seed the run config). Backend uses its own env-var defaults for the
 * `undefined` cases.
 */

export interface JudgeModelOption {
  label: string;
  /** undefined → backend falls back to DEFAULT_JUDGE_MODEL env var. */
  value: string | undefined;
  provider: "anthropic" | "openrouter";
}

export const JUDGE_MODEL_OPTIONS: JudgeModelOption[] = [
  { label: "Default (Claude Sonnet)", value: undefined, provider: "anthropic" },
  { label: "Claude Opus 4", value: "claude-opus-4-7", provider: "anthropic" },
  { label: "GPT-4o (OpenRouter)", value: "openai/gpt-4o", provider: "openrouter" },
  { label: "GPT-4o mini (OpenRouter)", value: "openai/gpt-4o-mini", provider: "openrouter" },
  { label: "Gemini 2.5 Pro (OpenRouter)", value: "google/gemini-2.5-pro", provider: "openrouter" },
  { label: "Llama 3.3 70B (OpenRouter)", value: "meta-llama/llama-3.3-70b-instruct", provider: "openrouter" },
];

const JUDGE_MODEL_KEY = "northstar.judge_model";
const BRAINTRUST_PROJECT_KEY = "northstar.braintrust_project";

const DEFAULT_BRAINTRUST_PROJECT = "northstar-eval";

export function getDefaultJudgeModel(): string {
  try {
    return localStorage.getItem(JUDGE_MODEL_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setDefaultJudgeModel(value: string): void {
  try {
    if (value) localStorage.setItem(JUDGE_MODEL_KEY, value);
    else localStorage.removeItem(JUDGE_MODEL_KEY);
  } catch {
    // localStorage unavailable — silently fall through to in-memory only.
  }
}

export function getDefaultBraintrustProject(): string {
  try {
    return localStorage.getItem(BRAINTRUST_PROJECT_KEY) ?? DEFAULT_BRAINTRUST_PROJECT;
  } catch {
    return DEFAULT_BRAINTRUST_PROJECT;
  }
}

export function setDefaultBraintrustProject(value: string): void {
  try {
    const trimmed = value.trim();
    if (trimmed && trimmed !== DEFAULT_BRAINTRUST_PROJECT) {
      localStorage.setItem(BRAINTRUST_PROJECT_KEY, trimmed);
    } else {
      localStorage.removeItem(BRAINTRUST_PROJECT_KEY);
    }
  } catch {
    // localStorage unavailable — silently fall through.
  }
}
