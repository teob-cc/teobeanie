import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDenyList, parseAllow, parseDeny, scanFolder, scanText } from "../src/privacy.js";

const rules = (text: string, opts = {}) => scanText("f.md", text, opts).map((h) => h.rule);

describe("privacy scan", () => {
  it("flags deny-list words as whole tokens, case-insensitively, with the line", () => {
    const hits = scanText("a.md", "fine\nvisit Zorgville today\nZorgvilleish is another word", { deny: ["zorgville"] });
    expect(hits).toEqual([{ file: "a.md", line: 2, rule: "deny-list", reason: expect.any(String) }]);
  });

  it("does not echo the matched word in the reason", () => {
    const [hit] = scanText("a.md", "Zorgville", { deny: ["zorgville"] });
    expect(hit!.reason.toLowerCase()).not.toContain("zorgville");
  });

  it("flags Telegram chat ids and bot tokens", () => {
    expect(rules("chat -1001234567890 here")).toEqual(["chat-id"]);
    expect(rules("id -123456789012")).toEqual(["chat-id"]);
    expect(rules("a range 2024-10-17 and -42 and 1-2")).toEqual([]);
    const token = `123456789:${"A".repeat(35)}`;
    expect(rules(`bot ${token}`)).toEqual(["bot-token"]);
  });

  it("flags JWT-shaped HA tokens", () => {
    const jwt = `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}`;
    expect(rules(`Authorization: Bearer ${jwt}`)).toEqual(["ha-token"]);
  });

  it("flags private and tailnet addresses except documented placeholders", () => {
    expect(rules("host 192.168.7.44")).toEqual(["private-ip"]);
    expect(rules("host 10.4.5.6 and 172.20.1.1")).toEqual(["private-ip", "private-ip"]);
    expect(rules("tailnet 100.88.1.2")).toEqual(["private-ip"]);
    expect(rules("lan 192.168.1.20, supervisor 172.30.32.2, tailnet 100.101.102.103")).toEqual([]);
    expect(rules("public 8.8.8.8 and version 1.2.3.4")).toEqual([]);
  });

  it("flags entity ids whose object id is not a placeholder, but not services or placeholders", () => {
    expect(rules("light.grandmas_reading_nook")).toEqual(["entity-id"]);
    expect(rules("call light.turn_on on light.hall and sensor.x")).toEqual([]);
    expect(rules("see foo.light.zzz_room and light.zzz_room(")).toEqual([]);
  });

  it("allows extra object ids and exempt files by option", () => {
    expect(rules("light.zzz_room", { allowObjectIds: ["zzz_room"] })).toEqual([]);
    expect(scanText("docs/x.md", "light.zzz_room", { allowFiles: ["docs/x.md"] })).toEqual([]);
    expect(scanText("docs/y.md", "light.zzz_room", { allowFiles: ["docs/x.md"] })).toHaveLength(1);
  });

  it("parses deny and allow files", () => {
    expect(parseDeny("# c\n\n Foo \nbar baz\n")).toEqual(["Foo", "bar baz"]);
    expect(parseAllow("# c\ndocs/x.md  # why\nobject:zzz_room  # generic\n")).toEqual({ files: ["docs/x.md"], objectIds: ["zzz_room"] });
  });

  it("loads the deny list from PRIVACY_DENY first, then PRIVACY_DENY_FILE, else warns by returning none", () => {
    expect(loadDenyList({ PRIVACY_DENY: "a\nb" })).toEqual({ words: ["a", "b"], source: "PRIVACY_DENY" });
    const dir = mkdtempSync(join(tmpdir(), "priv-"));
    const file = join(dir, "deny.txt");
    writeFileSync(file, "c\n");
    expect(loadDenyList({ PRIVACY_DENY_FILE: file })).toEqual({ words: ["c"], source: file });
    expect(loadDenyList({ PRIVACY_DENY_FILE: join(dir, "missing.txt") })).toEqual({ words: [], source: null });
  });

  it("scans a folder recursively, skipping node_modules and binary files", () => {
    const dir = mkdtempSync(join(tmpdir(), "priv-"));
    mkdirSync(join(dir, "sub"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "sub", "a.json"), '{\n "chat": -1009876543210\n}\n');
    writeFileSync(join(dir, "node_modules", "b.json"), '{"chat": -1009876543210}');
    writeFileSync(join(dir, "pic.png"), "192.168.9.9");
    const hits = scanFolder(dir);
    expect(hits.map((h) => `${h.file}:${h.line}:${h.rule}`)).toEqual(["sub/a.json:2:chat-id"]);
  });
});
