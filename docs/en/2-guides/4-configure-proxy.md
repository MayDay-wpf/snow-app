# 4-configure-proxy

Snow App's proxy settings apply to application session network requests, web search, and the built-in browser. This guide covers the proxy, search engine, browser, and global site-blocking rules.

## 1. Configuration Entries

| Entry                                                                   | Description                                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Settings → Proxy & Browser (settings page id: `proxy-browser-settings`) | GUI for proxy, search engine, built-in browser, and site-blocking rules                  |
| `~/.snow/proxy-config.json`                                             | File-backed proxy, search-engine, and browser fields exposed by the `proxy` config scope |
| App database system setting `proxy_browser_settings`                    | Complete proxy/browser setting used by the UI, including `blockedPatterns`               |

The proxy, search-engine, and browser fields are managed by the file-backed `proxy` scope; the settings panel also saves the complete setting in the app database. `blockedPatterns` is not part of `proxy-config.json`; the runtime source of truth is the app database setting `proxy_browser_settings`.

## 2. Configuring the Proxy

| Field     | Description                           |
| --------- | ------------------------------------- |
| `enabled` | Enable switch: whether to use a proxy |
| `host`    | Proxy host, e.g. `127.0.0.1`          |
| `port`    | Proxy port, e.g. `7890`               |

## 3. Configuring the Search Engine

| Field          | Description                              |
| -------------- | ---------------------------------------- |
| `searchEngine` | Search engine, e.g. `bing`, `duckduckgo` |

This setting affects the search result source of the `websearch` tool.

## 4. Configuring the Built-in Browser

| Field              | Description                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `browserPath`      | Browser executable path; when empty, Chrome / Edge / Chromium is auto-detected, or click Browse to select manually |
| `browserDebugPort` | Browser debug port, e.g. `9222`                                                                                    |

The debug port is used for the built-in browser panel connection; if the port is occupied, the panel may fail to open.

## 5. Site-blocking Rules

`blockedPatterns` is a global app-level array of site-blocking rules. It is not project-scoped and does not change with the current `projectId`. Configure one JavaScript regular expression per line; the settings panel and the dedicated app-control update tool validate rules with JavaScript `RegExp`.

The rules apply as follows:

- `websearch` filters search results whose site matches a rule;
- `websearch-fetch` refuses to fetch a target whose site matches a rule;
- invalid JavaScript regexes cannot be saved or updated normally. The Rust fetch path uses `regex::Regex`, whose syntax is not identical to JavaScript `RegExp`; a rule that Rust cannot compile is skipped or has no effect there.

Use domain boundaries for recommended rules. For example, in JSON tool arguments write `(^|\\.)example\\.com$`: `(^|\\.)` means the start of the domain or a preceding dot, so it matches `example.com` and its subdomains; `$` requires the match to end at the domain boundary and avoids matching a longer domain. Do not pass unvalidated user input as a regular expression.

The AI can maintain the rules through the `appSettings` scope of the `config-manage` tool:

| Call                                                             | Purpose                             |
| ---------------------------------------------------------------- | ----------------------------------- |
| `config-manage action=get scope=appSettings key=blockedPatterns` | Read the current global rule array  |
| `config-manage action=set scope=appSettings key=blockedPatterns` | Add, remove, or fully replace rules |

The `value` of `config-manage` with `action=set` may be a rule array (full replace), or an object with exactly one operation key:

```json
{
  "add": ["(^|\\\\\\\\.)example\\\\\\\\.com$"]
}
```

The operation key is `add`, `remove`, or `replace`, with these semantics:

- `add`: trim surrounding whitespace, remove exact duplicates, and preserve existing order;
- `remove`: delete exact complete strings;
- `replace`: replace the current list with the supplied array;
- each `patterns` item must be a non-empty string and pass JavaScript regex validation.

## 6. Scope of Effect

- **App session proxy**: network requests and update checks;
- **AI model requests**: Rust-side provider adapters (OpenAI Chat / Responses, Anthropic, Gemini), model listing, summaries, embeddings, reranking, and codebase review all send their outbound requests through this proxy;
- **Remote MCP (`http` transport)**: `server/discover`, `initialize`, `tools/list`, and `tools/call` all go through the proxy;
- **Web search**: the `websearch` tool, with matching sites filtered;
- **Page fetching**: the `websearch-fetch` tool, with matching targets refused;
- **Built-in browser panel**: embedded browser instances;
- **Site-blocking rules**: global app settings, not project-level configuration.

Loopback and private networks always connect directly and bypass the proxy: `localhost`, `127.0.0.1`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, `fc00::/7`, `fe80::/10`; entries in the `NO_PROXY` / `no_proxy` environment variables are honored as well. MCP servers using the `stdio` transport do their own networking in the child process and are not affected by this proxy.

No restart is required after changing proxy settings: newly opened or reconnected MCP connections and subsequent AI requests pick up the new configuration immediately.

## 7. AI / CLI Configuration (config-manage tool)

The `config-manage` tool can read and write the file-backed `proxy` scope, but that scope does not support `blockedPatterns`:

| Tool                                                                                                                      | Example                                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `config-manage action=get scope=proxy`                                                                                    | View the proxy, search-engine, and browser fields supported by `proxy-config.json` |
| `config-manage action=set scope=proxy value={enabled: true, host: "127.0.0.1", port: 7890}`                               | Enable the proxy                                                                   |
| `config-manage action=set scope=proxy key=searchEngine value="duckduckgo"`                                                | Switch the search engine                                                           |
| `config-manage action=set scope=proxy key=browserPath value="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"` | Set the browser path (escape Windows backslashes)                                  |

Do not use `config-manage action=get scope=proxy key=blockedPatterns` or `config-manage action=set scope=proxy key=blockedPatterns` to maintain runtime rules; they are not in the current `PROXY_SCOPE_KEYS` whitelist. Maintain site-blocking rules through the settings panel or the dedicated app-control tools above. File-backed config changes may require an app restart or a UI re-save; dedicated app-control updates write the app database and re-apply proxy settings directly.

## 8. FAQ

| Symptom                                      | Cause & fix                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Blocked sites still appear in search results | Check that each rule is valid JavaScript regex and matches the result site's domain        |
| A page fetch is refused                      | The target matched a global `blockedPatterns` rule; read the rules and remove it if needed |
| Browser panel won't open                     | Check whether `browserPath` is correct, or the debug port is occupied                      |
| Changes don't take effect                    | Make sure the settings were saved; rule updates re-apply proxy settings                    |

## 9. Reference

- Built-in tools reference: [3-reference/2-builtin-tools-reference](../3-reference/2-builtin-tools-reference.md)
- Config field reference: [3-reference/3-config-file-field-reference](../3-reference/3-config-file-field-reference.md)
