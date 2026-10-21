// monaco.ts — the editor, loaded only when the Studio opens: Monaco with its
// TypeScript language service in a worker, configured to check rules against the
// "teobeanie" module (the add-on's own emitted declarations) and this house's entities.

import * as monaco from "monaco-editor/editor";
import "monaco-editor/features/register.all";
import "monaco-editor/languages/definitions/typescript/register";
import * as ts from "monaco-editor/languages/features/typescript/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";
import testDts from "./teobeanie-test.d.ts.txt?raw";

self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === "typescript" || label === "javascript" ? new TsWorker() : new EditorWorker()),
};

ts.typescriptDefaults.setCompilerOptions({
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  strict: true,
  noEmit: true,
  allowNonTsExtensions: true,
  lib: ["esnext"],
});
ts.typescriptDefaults.setEagerModelSync(true);

/**
 * Install the "teobeanie" module and the house's entities as editor-only declarations,
 * the module also as "teob" (its name before the rename) for older rule files.
 */
export function setTypes(toolkit: Record<string, string>, house: string): void {
  const libs = ["teobeanie", "teob"].flatMap((pkg) => [
    ...Object.entries(toolkit).map(([path, content]) => ({
      // toolkit.d.ts is the package entry: node_modules/teobeanie/index.d.ts.
      filePath: `file:///node_modules/${pkg}/${path === "toolkit.d.ts" ? "index.d.ts" : path}`,
      content,
    })),
    { filePath: `file:///node_modules/${pkg}/test.d.ts`, content: testDts },
  ]);
  libs.push({ filePath: "file:///ha.d.ts", content: house });
  ts.typescriptDefaults.setExtraLibs(libs);
}

export const uriOf = (name: string) => monaco.Uri.parse(`file:///heuristics/${name}`);
/** A package file by "<package>/<file>". */
export const libUriOf = (key: string) => monaco.Uri.parse(`file:///packages/${key}`);

/** Read-only models for the packages' files (once each). */
export function addLibraryModels(files: Array<{ key: string; text: string }>): void {
  for (const f of files) {
    if (!monaco.editor.getModel(libUriOf(f.key))) monaco.editor.createModel(f.text, "typescript", libUriOf(f.key));
  }
}

export { monaco };
