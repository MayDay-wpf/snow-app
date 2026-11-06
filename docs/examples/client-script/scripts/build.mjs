import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const normalize = (text) => text.replaceAll("\r\n", "\n");
const input = normalize(
  await readFile(path.join(root, "src/index.ts"), "utf8"),
);
const metadata = input.match(
  /^\/\/ ==UserScript==\n[\s\S]*?^\/\/ ==\/UserScript==/m,
)?.[0];
if (!metadata || !input.startsWith(metadata)) {
  throw new Error("src/index.ts must begin with a UserScript metadata block");
}
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts"],
  outfile: "chat-shortcut.user.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  write: false,
  metafile: true,
  legalComments: "none",
  banner: { js: metadata },
  logLevel: "warning",
});
if (
  result.outputFiles.length !== 1 ||
  Object.values(result.metafile.outputs).some(
    (output) => output.imports.length !== 0,
  )
) {
  throw new Error(
    "Client script must be one self-contained IIFE without runtime imports",
  );
}
const output = normalize(result.outputFiles[0].text);
if (!output.startsWith(`${metadata}\n`))
  throw new Error("UserScript metadata was not preserved");
const target = path.join(root, "dist/chat-shortcut.user.js");
if (check) {
  if (normalize(await readFile(target, "utf8")) !== output) {
    throw new Error("chat-shortcut.user.js is stale; run npm run build");
  }
} else {
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(target, output, "utf8");
}
console.log(
  check ? "Client script matches source." : "Built dist/chat-shortcut.user.js.",
);
