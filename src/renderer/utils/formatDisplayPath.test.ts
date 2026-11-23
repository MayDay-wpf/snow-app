import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDisplayPath, normalizePathForCompare } from "./formatDisplayPath.ts";

const cases = [
  {
    name: "verbatim drive path",
    prefixed: String.raw`\\?\C:\Repo`,
    ordinary: String.raw`C:\Repo`,
    normalized: "c:/repo",
  },
  {
    name: "verbatim UNC path",
    prefixed: String.raw`\\?\UNC\Server\Share\Repo`,
    ordinary: String.raw`\\Server\Share\Repo`,
    normalized: "//server/share/repo",
  },
  {
    name: "verbatim drive path with forward slashes",
    prefixed: "//?/C:/Repo",
    ordinary: "C:/Repo",
    normalized: "c:/repo",
  },
];

for (const { name, prefixed, ordinary, normalized } of cases) {
  test(name, () => {
    assert.equal(formatDisplayPath(prefixed), ordinary);
    assert.equal(formatDisplayPath(ordinary), ordinary);
    assert.equal(normalizePathForCompare(prefixed), normalized);
    assert.equal(normalizePathForCompare(ordinary), normalized);
  });
}
