import type { LspServerConfigInput } from "../../../../preload";
import type { LspServerConfig, LspServerDraft, LspStringItem } from "./types";

let stringItemSeq = 0;

export const createLspStringItem = (value = ""): LspStringItem => {
  stringItemSeq += 1;
  return { id: `lsp-item-${stringItemSeq}`, value };
};

/** 解析 JSON 数组字符串；非法时返回空数组。 */
const parseJsonArray = (json: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(json || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

/** 解析 JSON 对象字符串并美化；非法/空时返回空字符串。 */
export const formatJsonObject = (json: string): string => {
  if (!json.trim()) {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
};

/** 校验初始化选项 JSON 文本；返回错误信息（空字符串 = 合法）。 */
export const validateInitializationOptions = (text: string): string => {
  if (!text.trim()) {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return "initializationOptions must be a JSON object";
    }
    return "";
  } catch {
    return "initializationOptions must be valid JSON";
  }
};

export const PRESET_SERVER_TEMPLATES: Record<
  string,
  {
    command: string;
    args: string[];
    fileExtensions: string[];
    installCommand: string;
  }
> = {
  python: {
    command: "pyright-langserver",
    args: ["--stdio"],
    fileExtensions: [".py", ".pyi"],
    installCommand:
      "npm install -g pyright || pip install --user pyright || pipx install pyright || pip3 install pyright --break-system-packages || pip install pyright",
  },
  "python (pylsp)": {
    command: "pylsp",
    args: [],
    fileExtensions: [".py", ".pyi"],
    installCommand:
      "pip install --user python-lsp-server || pip install python-lsp-server || pipx install python-lsp-server",
  },
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    fileExtensions: [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mts",
      ".cts",
      ".mjs",
      ".cjs",
    ],
    installCommand:
      "npm install -g typescript-language-server typescript || pnpm add -g typescript-language-server typescript || yarn global add typescript-language-server typescript",
  },
  go: {
    command: "gopls",
    args: [],
    fileExtensions: [".go"],
    installCommand:
      "go install golang.org/x/tools/gopls@latest || brew install gopls || apt install -y gopls || pacman -S --noconfirm gopls",
  },
  rust: {
    command: "rust-analyzer",
    args: [],
    fileExtensions: [".rs"],
    installCommand:
      "rustup component add rust-analyzer || brew install rust-analyzer || apt install -y rust-analyzer || pacman -S --noconfirm rust-analyzer || cargo install --locked rust-analyzer",
  },
  c: {
    command: "clangd",
    args: ["--background-index"],
    fileExtensions: [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hxx"],
    installCommand:
      "apt install -y clangd || brew install llvm || winget install LLVM.LLVM || pacman -S --noconfirm clang",
  },
  csharp: {
    command: "csharp-ls",
    args: [],
    fileExtensions: [".cs"],
    installCommand:
      "dotnet tool install --global csharp-ls || dotnet tool update --global csharp-ls",
  },
  java: {
    command: "jdtls",
    args: [],
    fileExtensions: [".java"],
    installCommand:
      "apt install -y eclipse-jdtls || brew install jdtls || scoop install jdtls || pacman -S --noconfirm jdtls",
  },
  kotlin: {
    command: "kotlin-language-server",
    args: ["--stdio"],
    fileExtensions: [".kt", ".kts"],
    installCommand:
      "brew install kotlin-language-server || snap install kotlin-language-server --classic || scoop install kotlin-language-server || pacman -S --noconfirm kotlin-language-server",
  },
  php: {
    command: "intelephense",
    args: ["--stdio"],
    fileExtensions: [".php"],
    installCommand:
      "npm install -g intelephense || pnpm add -g intelephense || yarn global add intelephense || brew install intelephense",
  },
  ruby: {
    command: "ruby-lsp",
    args: ["--stdio"],
    fileExtensions: [".rb", ".rake", ".gemspec", ".ru", ".erb"],
    installCommand:
      "gem install --user-install ruby-lsp || gem install ruby-lsp || brew install ruby-lsp",
  },
  lua: {
    command: "lua-language-server",
    args: [],
    fileExtensions: [".lua"],
    installCommand:
      "apt install -y lua-language-server || brew install lua-language-server || winget install lua-language-server || pacman -S --noconfirm lua-language-server || scoop install lua-language-server",
  },
  swift: {
    command: "sourcekit-lsp",
    args: [],
    fileExtensions: [".swift"],
    installCommand: "",
  },
};

export const getPresetTemplate = (lang: string) => {
  const normalized = lang.trim().toLowerCase();
  return PRESET_SERVER_TEMPLATES[normalized];
};

export const toDraft = (server: LspServerConfig): LspServerDraft => ({
  id: server.id,
  lang: server.lang,
  command: server.command,
  args: parseJsonArray(server.argsJson).map(createLspStringItem),
  fileExtensions: parseJsonArray(server.fileExtensionsJson).map(
    createLspStringItem,
  ),
  installCommand: server.installCommand ?? "",
  initializationOptions: formatJsonObject(
    server.initializationOptionsJson ?? "",
  ),
  enabled: server.enabled,
  sortOrder: server.sortOrder,
  source: server.source,
});

export const toInput = (draft: LspServerDraft): LspServerConfigInput => ({
  lang: draft.lang.trim(),
  command: draft.command.trim(),
  argsJson: JSON.stringify(draft.args.map((item) => item.value)),
  fileExtensionsJson: JSON.stringify(
    draft.fileExtensions.map((item) => item.value),
  ),
  // napi Option<String> 不接受 null：空值省略字段（undefined）
  ...(draft.installCommand.trim()
    ? { installCommand: draft.installCommand.trim() }
    : {}),
  ...(draft.initializationOptions.trim()
    ? { initializationOptionsJson: draft.initializationOptions.trim() }
    : {}),
  enabled: draft.enabled,
  sortOrder: draft.sortOrder,
  source: draft.source,
});
