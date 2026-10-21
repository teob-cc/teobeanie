#!/usr/bin/env node
// Privacy scan: fails with file:line:reason when the tree holds one real house's strings.
//   node scripts/privacy-scan.mjs            tracked files of this repo (git ls-files)
//   node scripts/privacy-scan.mjs <folder>   every text file below a folder (e.g. an exported package)
// Deny list: PRIVACY_DENY (newline separated) or the file PRIVACY_DENY_FILE
// (default ~/.config/teobeanie/privacy-deny.txt). Missing = warning, other checks still run.
// Needs Node >= 22.18 (it loads src/privacy.ts directly).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatHit, loadDenyList, parseAllow, scanFolder } from "../src/privacy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.argv[2] ?? join(here, ".."));
const { words, source } = loadDenyList();
if (!source) {
  console.warn("privacy-scan: WARNING no deny list (set PRIVACY_DENY or PRIVACY_DENY_FILE); person/place words are NOT checked");
}
const allowPath = join(here, "privacy-allow.txt");
const allow = existsSync(allowPath) ? parseAllow(readFileSync(allowPath, "utf8")) : { files: [], objectIds: [] };

const hits = scanFolder(target, { deny: words, allowFiles: allow.files, allowObjectIds: allow.objectIds, useGit: process.argv[2] === undefined });
for (const h of hits) console.error(formatHit(h));
const byRule = {};
for (const h of hits) byRule[h.rule] = (byRule[h.rule] ?? 0) + 1;
if (hits.length) {
  console.error(`privacy-scan: FAILED ${hits.length} hit(s) ${JSON.stringify(byRule)}`);
  process.exit(1);
}
console.log(`privacy-scan: ok (${target}${source ? `, deny list from ${source}: ${words.length} entries` : ", no deny list"})`);
