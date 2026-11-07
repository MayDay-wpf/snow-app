import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const normalize = (text) => text.replaceAll("\r\n", "\n");
const output = "index.js";
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts"],
  outfile: output,
  bundle: true,
  splitting: false,
  // The host inserts <script src="...">, not a module script or HTML entry.
  format: "iife",
  platform: "browser",
  target: "es2022",
  write: false,
  metafile: true,
  legalComments: "none",
  logLevel: "warning",
});
if (
  result.outputFiles.length !== 1 ||
  Object.keys(result.metafile.outputs).length !== 1
) {
  throw new Error("Panel entry must produce exactly one JavaScript file");
}
if (
  Object.keys(result.metafile.inputs).some((input) => !input.startsWith("src/"))
) {
  throw new Error("The DOM example must not bundle framework dependencies");
}
for (const artifact of Object.values(result.metafile.outputs)) {
  if (artifact.imports.length !== 0 || artifact.exports.length !== 0) {
    throw new Error("Iframe entry must be a self-contained classic script");
  }
}
const target = path.join(root, output);
const source = normalize(result.outputFiles[0].text);
if (check) {
  if (normalize(await readFile(target, "utf8")) !== source) {
    throw new Error(`${output} is stale; run npm run build`);
  }
} else {
  await writeFile(target, source, "utf8");
}
console.log(check ? "Artifacts match sources." : "Built index.js (IIFE).");
