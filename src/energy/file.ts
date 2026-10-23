// file.ts — energy.json in the config folder, read and checked.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EMPTY_ENERGY_FILE, parseEnergyFile, type EnergyFile } from "./config.js";

export const ENERGY_FILE = "energy.json";

/** energy.json in the config folder; the defaults without one. Throws on a file that will not do. */
export function loadEnergyFile(configDir: string): EnergyFile {
  const path = join(configDir, ENERGY_FILE);
  if (!existsSync(path)) return EMPTY_ENERGY_FILE;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path}: unparseable JSON: ${(err as Error).message}`);
  }
  return parseEnergyFile(raw, path);
}
