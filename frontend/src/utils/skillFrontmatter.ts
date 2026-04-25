/**
 * Parse YAML-ish frontmatter from a SKILL.md body. Returns the body with
 * frontmatter stripped, plus the `name` and `description` keys when present.
 *
 * Shared between SkillPanel (manual paste / Analyze button) and Home (the
 * "new skill eval" modal) so both code paths populate skill metadata
 * identically. Without this, pasting via Home left skill_name/description
 * empty because Home wasn't parsing frontmatter before calling seedFromSkill.
 */
export function parseSkillFrontmatter(raw: string): {
  name?: string;
  description?: string;
  body: string;
} {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { body: raw };
  const front = match[1];
  const body = match[2];
  const lines = front.split(/\r?\n/);
  const pick = (key: string) => {
    const line = lines.find((l) => l.trim().toLowerCase().startsWith(`${key}:`));
    if (!line) return undefined;
    const value = line.split(":").slice(1).join(":").trim();
    return value.replace(/^["']|["']$/g, "") || undefined;
  };
  return { name: pick("name"), description: pick("description"), body };
}

/**
 * Pick the first available project name that doesn't collide with one already
 * taken. Suffixes the candidate with " 2", " 3", ... until it fits.
 *
 *   uniqueProjectName("foo", new Set(["foo", "foo 2"])) === "foo 3"
 */
export function uniqueProjectName(base: string, taken: Set<string>): string {
  const trimmed = base.trim();
  if (!trimmed) return trimmed;
  if (!taken.has(trimmed)) return trimmed;
  let n = 2;
  while (taken.has(`${trimmed} ${n}`)) n += 1;
  return `${trimmed} ${n}`;
}
