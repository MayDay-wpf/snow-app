# Text tool reference

- Operation identifier: `text_inspect`. Discover its exact public name before calling it.
- Input: supplied text; the discovered MCP schema is the parameter contract.
- `codePoints`: Unicode code-point count, not UTF-16 length or grapheme count.
- `lines`: zero for an empty string; otherwise split on CRLF, CR or LF. A trailing newline adds an empty final line.
- No network, file access, writes or persistence. The result is complete JSON, never a sliced JSON string.

The SDK checks the input boundary and reports invalid arguments as an error. Do not substitute empty input or retry with different text after a validation failure.
