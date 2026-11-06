import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const normalize = (text) => text.replaceAll("\r\n", "\n");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/oauth.ts"],
  outfile: "oauth.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  metafile: true,
  legalComments: "none",
  logLevel: "warning",
});
if (
  result.outputFiles.length !== 1 ||
  Object.values(result.metafile.outputs).some((output) =>
    output.imports.some((item) => !item.path.startsWith("node:")),
  )
) {
  throw new Error(
    "OAuth output must be one ESM file with only Node built-in imports",
  );
}
const artifacts = new Map([
  ["oauth.mjs", result.outputFiles[0].text],
  ["plugin.json", await readFile(path.join(root, "plugin.json"), "utf8")],
  ["config.json", await readFile(path.join(root, "config.json"), "utf8")],
]);
if (!check) await mkdir(path.join(root, "dist"), { recursive: true });
for (const [name, source] of artifacts) {
  const target = path.join(root, "dist", name);
  if (check) {
    if (normalize(await readFile(target, "utf8")) !== normalize(source)) {
      throw new Error(`${name} is stale; run npm run build`);
    }
  } else {
    await writeFile(target, normalize(source), "utf8");
  }
}
console.log(
  check
    ? "OAuth artifacts match sources."
    : "Built dist/oauth.mjs, plugin.json and config.json.",
);
