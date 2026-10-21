// library.ts — the behaviour packages in the config folder (packages/<name>/), shown
// read-only in the Studio: their TypeScript files as the add-on runs them, fetched from
// api/studio/packages. They import from "teobeanie" like the house's own files, so the
// editor checks them with the same types.

import { api, type StudioPackage } from "../api";

/** A package's TypeScript file, with the heuristics it defines. */
export interface LibraryFile {
  /** "door-watch/door-nag.ts" */
  key: string;
  pkg: StudioPackage;
  name: string;
  text: string;
  /** The heuristic ids this file defines. */
  ids: string[];
}

const isTs = (f: string) => /\.(ts|js|mjs)$/.test(f) && !f.endsWith(".d.ts");

/** Every package's source and spec files. */
export async function loadLibraryFiles(): Promise<LibraryFile[]> {
  const { packages } = await api.studioPackages();
  const files = await Promise.all(
    packages.flatMap((pkg) =>
      pkg.files.filter(isTs).map(async (name): Promise<LibraryFile> => ({
        key: `${pkg.name}/${name}`,
        pkg,
        name,
        text: await api.studioPackageFile(pkg.name, name),
        ids: Object.entries(pkg.sources)
          .filter(([, f]) => f === name)
          .map(([id]) => id),
      })),
    ),
  );
  return files.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * A package file as a starting point in heuristics/: ids renamed so they do not collide
 * with the package's own. It already imports from "teobeanie" and default-exports its
 * heuristics.
 */
export function copyForConfig(file: LibraryFile, suffix: string): { text: string; ids: string[] } {
  let text = file.text;
  for (const id of file.ids) {
    text = text.replace(`id: "${id}",`, `id: "${id}-${suffix}",`).replace(new RegExp(`(\\brule(?:<[^>]*>)?\\(\\s*)"${id}"`), `$1"${id}-${suffix}"`);
  }
  return { text, ids: file.ids.map((id) => `${id}-${suffix}`) };
}
