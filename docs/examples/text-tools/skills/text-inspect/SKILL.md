---
name: text-inspect
description: Use the Text tools plugin to count Unicode code points and lines without reading files or using the network.
---

# Inspect text

This plugin provides `text_inspect`, a read-only operation on supplied text.

Read the [tool reference](references/tools.md) only when the task needs exact counting semantics. Resolve relative links against this skill directory; do not expand all references automatically.

Find `text_inspect` with `toolSearch-discover`, then call the exact public name from the result. The operation identifier is not a complete public tool name. Discovery does not grant permission or bypass approvals.

Return the tool's counts without resending the full input. Do not interpret code-point count as user-perceived character or grapheme count.
