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
  entryPoints: ["src/index.tsx"],
  outfile: output,
  bundle: true,
  splitting: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "transform",
  jsxFactory: "React.createElement",
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
  throw new Error("Use host React and icons; do not bundle dependencies");
}
for (const artifact of Object.values(result.metafile.outputs)) {
  if (artifact.imports.length !== 0) {
    throw new Error("Panel entry must be self-contained without imports");
  }
  if (artifact.exports.length !== 1 || artifact.exports[0] !== "default") {
    throw new Error("ESM entry must default-export the panel component");
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
console.log(check ? "Artifacts match sources." : "Built index.js (ESM).");
