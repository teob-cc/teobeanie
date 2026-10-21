// The agent skills (skills/*/SKILL.md) and the Claude Code plugin that ships them.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const skills = readdirSync(join(root, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

/** The YAML frontmatter's top-level `key: value` lines. */
function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (m === null) return {};
  return Object.fromEntries(m[1]!.split("\n").map((l) => /^([a-z_-]+):\s*(.*)$/.exec(l)).filter((x) => x !== null).map((x) => [x[1]!, x[2]!]));
}

/** The MCP tools the add-on serves, by name, read from their definitions. */
const TOOLS = new Set([...readFileSync(join(root, "src", "mcp", "tools.ts"), "utf8").matchAll(/tool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!));

describe("skills", () => {
  it("are the five, each a SKILL.md whose name is its folder and whose description says when to use it", () => {
    expect(skills.sort()).toEqual(["develop", "explain", "nodered-migration", "onboard", "operate"]);
    for (const name of skills) {
      const fm = frontmatter(readFileSync(join(root, "skills", name, "SKILL.md"), "utf8"));
      expect(fm["name"]).toBe(name);
      expect(fm["description"]).toMatch(/Use when/);
      expect(fm["description"]!.length).toBeLessThanOrEqual(1024);
    }
  });

  it("name only MCP tools the add-on has", () => {
    expect(TOOLS.size).toBeGreaterThanOrEqual(13);
    const explain = readFileSync(join(root, "skills", "explain", "SKILL.md"), "utf8");
    const listed = [...explain.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]!);
    expect(listed.length).toBeGreaterThan(5);
    for (const t of listed) expect(TOOLS.has(t), t).toBe(true);
    // Every `tool` named as a call target ("`decisions` with …") in any skill is real.
    for (const name of skills) {
      const text = readFileSync(join(root, "skills", name, "SKILL.md"), "utf8");
      for (const m of text.matchAll(/`([a-z_]+)` with /g)) expect(TOOLS.has(m[1]!), `${name}: ${m[1]}`).toBe(true);
    }
  });

  it("point at scripts that exist", () => {
    for (const name of skills) {
      const text = readFileSync(join(root, "skills", name, "SKILL.md"), "utf8");
      for (const m of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+[\w])/g)) expect(existsSync(join(root, m[1]!)), `${name}: ${m[1]}`).toBe(true);
    }
  });
});

describe("the plugin", () => {
  it("is the repository root, listed once in its own marketplace under the same name", () => {
    const market = json(join(root, ".claude-plugin", "marketplace.json")) as { name: string; plugins: Array<{ name: string; source: string }> };
    const plugin = json(join(root, ".claude-plugin", "plugin.json")) as { name: string };
    expect(market.name).toBe("teobeanie");
    expect(market.plugins).toHaveLength(1);
    expect(market.plugins[0]).toMatchObject({ name: plugin.name, source: "./" });
  });
});
