# 7-Codebase Index & Symbol Location

Snow App provides codebase semantic search (the `codebase` server) and code
symbol location (the `codelens` server) to help the agent understand and
navigate code quickly.

## 1. Codebase semantic search (codebase)

### 1.1 Enable and index

`codebase-search` is **only exposed when the project has codebase indexing
enabled and an index has been built**. Enable indexing for the project in
**Settings → Codebase Settings** (`app-control-openSettings
page=codebase-settings`) and configure the embedding model (see the
`codebase` field of `settings.json`; structure is documented in
`3-config-file-field-reference`). The first index may take a few minutes.

```mermaid
flowchart TD
    A[Settings → Codebase Settings<br/>enable indexing for the project] --> B[Configure the embedding model<br/>codebase field of settings.json]
    B --> C[First index<br/>may take a few minutes]
    C --> D{Index built?}
    D -- yes --> E[codebase-search exposed<br/>semantic search available]
    D -- no --> F[Wait for indexing<br/>tool unavailable meanwhile]
    F --> C
```

### 1.2 Tool

| Tool | Purpose |
| --- | --- |
| `codebase-search` | Semantic search over the embedding index |

Parameters: `query` (natural-language query text, required), `topN` (result
cap, default 10, max 50).

### 1.3 Example

```text
codebase-search query="how is config backslash escaping handled" topN=10
→ returns semantically related code snippets

codebase-search query="retry logic" topN=5
→ returns semantically related code snippets
```

### 1.4 Choosing between grep and codebase

| Scenario | Use |
| --- | --- |
| Exact keywords, regex, path-limited search | `grep-search` (faster, precise) |
| Semantic/intent queries ("find the login handling logic") | `codebase-search` (understands meaning) |

## 2. Code symbol location (codelens)

The `codelens` server performs lightweight static analysis (oxc /
tree-sitter based) for symbol resolution and reference lookup without
running a full LSP.

### 2.1 Tools

| Tool | Purpose |
| --- | --- |
| `codelens-find_definition` | Find a symbol's definition location |
| `codelens-find_references` | Find a symbol's references within the file |
| `codelens-file_outline` | Get a file's symbol outline (functions/classes/variables) |

### 2.2 Examples

```text
# Understand file structure
codelens-file_outline filePath=src/main/app/bootstrap.ts
→ top-level symbol list

# Jump to definition (pair with filesystem-read)
codelens-find_definition filePath=src/main/native/types.ts line=414 column=20
→ symbol name + definition location
```

### 2.3 Notes

- `find_definition`/`find_references` locate symbols by **line + column**:
  use `filesystem-read` to find the target position first.

### 2.4 About LSP (lsp-config.json)

Snow App does **not run a full LSP** today: `codelens` is built-in static
analysis that spawns no external language-server process, so it works out of
the box without installing any language server.

`~/.snow/lsp-config.json` (scope: `lsp-config`) is a **reserved language-server
config scope**: the `config` tools can read/write and validate the file (field
structure and example in section 10 of
[3-config-file-field-reference](../3-reference/3-config-file-field-reference.md)),
but the current version does not wire up an LSP client runtime, so writing it
**does not change any behavior**.

## 3. Typical workflow

```text
1. Understand    → codelens-file_outline + filesystem-read key files
2. Locate        → grep-search (keywords) or codebase-search (semantic)
3. Formal check  → project build commands (tsc / cargo check / npm run check)
```
