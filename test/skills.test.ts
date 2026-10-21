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

const TOOL_FILES = ["tools.ts", "ha-tools.ts", "develop.ts"].map((f) => readFileSync(join(root, "src", "mcp", f), "utf8"));
/** The MCP tools the add-on serves, by name, read from their definitions (the house tools, the explore tools, develop and operate). */
const TOOLS = new Set(TOOL_FILES.flatMap((text) => [...text.matchAll(/tool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!)));
/** The snake_case words of the tools' code (their arguments and answers' fields) and the add-on's options: the others a skill may name. */
const NAMES = new Set([
  ...TOOLS,
  ...[...TOOL_FILES, readFileSync(join(root, "src", "mcp", "timeline.ts"), "utf8")].flatMap((text) => [...text.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)].map((m) => m[1]!)),
  ...[...readFileSync(join(root, "teobeanie", "config.yaml"), "utf8").matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]!),
]);

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
    expect(TOOLS.size).toBeGreaterThanOrEqual(39);
    for (const t of ["ha_registry", "ha_states", "ha_history", "ha_services", "suggest"]) expect(TOOLS.has(t), t).toBe(true);
    const explain = readFileSync(join(root, "skills", "explain", "SKILL.md"), "utf8");
    const listed = [...explain.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]!);
    expect(listed.length).toBeGreaterThan(5);
    for (const t of listed) expect(TOOLS.has(t), t).toBe(true);
    for (const name of skills) {
      const text = readFileSync(join(root, "skills", name, "SKILL.md"), "utf8");
      // Every `tool` named as a call target ("`decisions` with …") is real.
      for (const m of text.matchAll(/`([a-z_]+)` with /g)) expect(TOOLS.has(m[1]!), `${name}: ${m[1]}`).toBe(true);
      // Every row of a skill's tool table is a tool.
      for (const m of text.matchAll(/^\| `([a-z_]+)` \| (?!.*\|.*\|.*\|)/gm)) expect(TOOLS.has(m[1]!), `${name}: ${m[1]}`).toBe(true);
      // Every snake_case name in backticks is a tool, an argument or an add-on option.
      for (const m of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) expect(NAMES.has(m[1]!), `${name}: ${m[1]}`).toBe(true);
    }
  });

  it("develop and operate work over the develop and operate tools, with the SSH loop as the fallback", () => {
    const develop = readFileSync(join(root, "skills", "develop", "SKILL.md"), "utf8");
    const operate = readFileSync(join(root, "skills", "operate", "SKILL.md"), "utf8");
    for (const t of ["scope_add", "scope_operate", "instance_upsert", "test_run", "replay", "file_write", "package_scaffold", "package_export"]) expect(develop).toContain(`\`${t}\``);
    for (const t of ["instance_mode", "rollback", "revisions", "promote", "pause", "resume", "command", "twin_compare"]) expect(operate).toContain(`\`${t}\``);
    expect(develop).toMatch(/## Fallback: the config folder over SSH/);
    // The command-line fallback asks for the Home Assistant token it needs.
    expect(develop.slice(develop.indexOf("## Fallback"))).toMatch(/A Home Assistant token/);
    // The guardrails, as rules with their reasons.
    expect(operate).toMatch(/Name the rollback revision before the change/);
    expect(operate).toMatch(/Never pause or weaken a guard/);
    expect(operate).toMatch(/Never widen `operate` silently/);
    for (const text of [develop, operate]) expect(text.split("*Why:*").length).toBeGreaterThan(6);
  });

  it("onboard explores through the MCP tools, not Home Assistant's REST API", () => {
    const text = readFileSync(join(root, "skills", "onboard", "SKILL.md"), "utf8");
    for (const t of ["ha_registry", "ha_states", "suggest"]) expect(text).toContain(`\`${t}\``);
    expect(text).not.toMatch(/\/api\/(states|template|config)|curl /);
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
