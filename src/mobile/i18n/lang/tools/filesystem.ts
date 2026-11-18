/**
 * filesystem 工具族词条：文件工具卡片（filesystem-read / filesystem-replace_edit /
 * filesystem-create / filesystem-copy，渲染见 mobile/tools/filesystem.ts）与卡片内嵌的
 * 行级 diff（diff 自身的词条在 lang/tools/diff.ts，本文件不要重复登记）。
 *
 * 键前缀统一 remote.toolCall.filesystem.*，三语必须同键；折叠 / 参数 / 结果
 * 等公共词条归 lang/tools/common.ts（聚合器 lang/tools/index.ts 里 common 最后合并）。
 */

export const filesystemEn: Record<string, string> = {
  // 头部徽章（.tool-name 内的模块名，图标由渲染器补入）
  "remote.toolCall.filesystem.read": "Read",
  "remote.toolCall.filesystem.edit": "Edit",
  "remote.toolCall.filesystem.create": "Create",

  // 提示（结果回退 / 空态）
  "remote.toolCall.filesystem.noArguments": "No arguments",
  "remote.toolCall.filesystem.rawFallback":
    "Could not parse the result; showing raw text",

  // read：行范围与计数
  "remote.toolCall.filesystem.linesTotal": "{{count}} lines",
  "remote.toolCall.filesystem.linesRange": "L{{start}}-{{end}}",
  "remote.toolCall.filesystem.lineSingle": "L{{line}}",
  "remote.toolCall.filesystem.lineWindow":
    "Lines {{start}}-{{end}} of {{total}}",
  "remote.toolCall.filesystem.fileCount": "{{count}} files",
  "remote.toolCall.filesystem.entryCount": "{{count}} entries",
  "remote.toolCall.filesystem.imagePreview": "Image preview ({{mediaType}})",

  // replace_edit
  "remote.toolCall.filesystem.occurrence": "Occurrence",
  "remote.toolCall.filesystem.matchedLine": "matched at line {{line}}",
  "remote.toolCall.filesystem.matchedIndex": "matched at index {{index}}",

  // create
  "remote.toolCall.filesystem.created": "created {{path}}",
  "remote.toolCall.filesystem.overwrite": "Overwrite",
  "remote.toolCall.filesystem.directory": "Directory",

  // copy：源区间 → 目标位置 / 结论 / 省略
  "remote.toolCall.filesystem.copy": "Copy",
  "remote.toolCall.filesystem.copyRoute": "{{source}} → {{target}}",
  "remote.toolCall.filesystem.copySourceRange":
    "source lines {{start}}-{{end}}",
  "remote.toolCall.filesystem.copySourceLine": "source line {{line}}",
  "remote.toolCall.filesystem.copyTargetBefore": "before line {{line}}",
  "remote.toolCall.filesystem.copyTargetAfter": "after line {{line}}",
  "remote.toolCall.filesystem.copyTargetAppend": "append to end of file",
  "remote.toolCall.filesystem.copyTargetReplace":
    "replace lines {{start}}-{{end}}",
  "remote.toolCall.filesystem.copyPasted":
    "Pasted to lines {{start}}-{{end}} ({{total}} lines total)",
  "remote.toolCall.filesystem.copiedCount": "Pasted {{count}} lines",
  "remote.toolCall.filesystem.copyOmitted":
    "{{count}} lines omitted in the preview",
  "remote.toolCall.filesystem.copyFormatPending":
    "Queued for Prettier auto-format",

  // copy 剪切（deleteSource=true）：源区间粘贴后从源文件删除
  "remote.toolCall.filesystem.copyCut": "Cut",
  "remote.toolCall.filesystem.copyCutPasted":
    "Cut to lines {{start}}-{{end}} ({{total}} lines total)",
  "remote.toolCall.filesystem.copyCutCount": "Cut {{count}} lines",
  "remote.toolCall.filesystem.copyMoveSameFile":
    "Moved within the same file (source lines removed from lines {{start}}-{{end}})",
  "remote.toolCall.filesystem.copyRemovedSource":
    "{{count}} lines removed from the source file ({{total}} lines left)",
  "remote.toolCall.filesystem.copyRemovedSourceOnly":
    "{{count}} lines removed from the source file",

  // copy delete（mode=delete）：只删不粘
  "remote.toolCall.filesystem.copyDelete": "Delete",
  "remote.toolCall.filesystem.copyDeleted":
    "Deleted lines {{start}}-{{end}} ({{total}} lines total)",
  "remote.toolCall.filesystem.copyDeletedCount": "Deleted {{count}} lines",
};

export const filesystemZhCN: Record<string, string> = {
  "remote.toolCall.filesystem.read": "读取",
  "remote.toolCall.filesystem.edit": "编辑",
  "remote.toolCall.filesystem.create": "创建",

  "remote.toolCall.filesystem.noArguments": "无参数",
  "remote.toolCall.filesystem.rawFallback": "无法解析结构化结果，显示原文",

  "remote.toolCall.filesystem.linesTotal": "共 {{count}} 行",
  "remote.toolCall.filesystem.linesRange": "第 {{start}}-{{end}} 行",
  "remote.toolCall.filesystem.lineSingle": "第 {{line}} 行",
  "remote.toolCall.filesystem.lineWindow":
    "第 {{start}}-{{end}} 行，共 {{total}} 行",
  "remote.toolCall.filesystem.fileCount": "{{count}} 个文件",
  "remote.toolCall.filesystem.entryCount": "{{count}} 个条目",
  "remote.toolCall.filesystem.imagePreview": "图片预览（{{mediaType}}）",

  "remote.toolCall.filesystem.occurrence": "匹配序号",
  "remote.toolCall.filesystem.matchedLine": "匹配于第 {{line}} 行",
  "remote.toolCall.filesystem.matchedIndex": "匹配于第 {{index}} 处",

  "remote.toolCall.filesystem.created": "已创建 {{path}}",
  "remote.toolCall.filesystem.overwrite": "覆盖",
  "remote.toolCall.filesystem.directory": "目录",

  "remote.toolCall.filesystem.copy": "复制",
  "remote.toolCall.filesystem.copyRoute": "{{source}} → {{target}}",
  "remote.toolCall.filesystem.copySourceRange": "源第 {{start}}-{{end}} 行",
  "remote.toolCall.filesystem.copySourceLine": "源第 {{line}} 行",
  "remote.toolCall.filesystem.copyTargetBefore": "第 {{line}} 行之前",
  "remote.toolCall.filesystem.copyTargetAfter": "第 {{line}} 行之后",
  "remote.toolCall.filesystem.copyTargetAppend": "追加到文件末尾",
  "remote.toolCall.filesystem.copyTargetReplace": "替换第 {{start}}-{{end}} 行",
  "remote.toolCall.filesystem.copyPasted":
    "已粘贴到第 {{start}}-{{end}} 行，共 {{total}} 行",
  "remote.toolCall.filesystem.copiedCount": "已粘贴 {{count}} 行",
  "remote.toolCall.filesystem.copyOmitted": "粘贴内容中间省略 {{count}} 行",
  "remote.toolCall.filesystem.copyFormatPending":
    "已排队等待 Prettier 自动格式化",

  "remote.toolCall.filesystem.copyCut": "剪切",
  "remote.toolCall.filesystem.copyCutPasted":
    "已剪切到第 {{start}}-{{end}} 行，共 {{total}} 行",
  "remote.toolCall.filesystem.copyCutCount": "已剪切 {{count}} 行",
  "remote.toolCall.filesystem.copyMoveSameFile":
    "同文件内移动，源区间已从同文件第 {{start}}-{{end}} 行移除",
  "remote.toolCall.filesystem.copyRemovedSource":
    "源文件删除 {{count}} 行，现共 {{total}} 行",
  "remote.toolCall.filesystem.copyRemovedSourceOnly": "源文件删除 {{count}} 行",

  "remote.toolCall.filesystem.copyDelete": "删除",
  "remote.toolCall.filesystem.copyDeleted":
    "已删除第 {{start}}-{{end}} 行，现共 {{total}} 行",
  "remote.toolCall.filesystem.copyDeletedCount": "已删除 {{count}} 行",
};

export const filesystemZhTW: Record<string, string> = {
  "remote.toolCall.filesystem.read": "讀取",
  "remote.toolCall.filesystem.edit": "編輯",
  "remote.toolCall.filesystem.create": "建立",

  "remote.toolCall.filesystem.noArguments": "無參數",
  "remote.toolCall.filesystem.rawFallback": "無法解析結構化結果，顯示原文",

  "remote.toolCall.filesystem.linesTotal": "共 {{count}} 行",
  "remote.toolCall.filesystem.linesRange": "第 {{start}}-{{end}} 行",
  "remote.toolCall.filesystem.lineSingle": "第 {{line}} 行",
  "remote.toolCall.filesystem.lineWindow":
    "第 {{start}}-{{end}} 行，共 {{total}} 行",
  "remote.toolCall.filesystem.fileCount": "{{count}} 個檔案",
  "remote.toolCall.filesystem.entryCount": "{{count}} 個項目",
  "remote.toolCall.filesystem.imagePreview": "圖片預覽（{{mediaType}}）",

  "remote.toolCall.filesystem.occurrence": "符合序號",
  "remote.toolCall.filesystem.matchedLine": "符合於第 {{line}} 行",
  "remote.toolCall.filesystem.matchedIndex": "符合於第 {{index}} 處",

  "remote.toolCall.filesystem.created": "已建立 {{path}}",
  "remote.toolCall.filesystem.overwrite": "覆寫",
  "remote.toolCall.filesystem.directory": "目錄",

  "remote.toolCall.filesystem.copy": "複製",
  "remote.toolCall.filesystem.copyRoute": "{{source}} → {{target}}",
  "remote.toolCall.filesystem.copySourceRange": "來源第 {{start}}-{{end}} 行",
  "remote.toolCall.filesystem.copySourceLine": "來源第 {{line}} 行",
  "remote.toolCall.filesystem.copyTargetBefore": "第 {{line}} 行之前",
  "remote.toolCall.filesystem.copyTargetAfter": "第 {{line}} 行之後",
  "remote.toolCall.filesystem.copyTargetAppend": "附加至檔案結尾",
  "remote.toolCall.filesystem.copyTargetReplace": "取代第 {{start}}-{{end}} 行",
  "remote.toolCall.filesystem.copyPasted":
    "已貼上至第 {{start}}-{{end}} 行，共 {{total}} 行",
  "remote.toolCall.filesystem.copiedCount": "已貼上 {{count}} 行",
  "remote.toolCall.filesystem.copyOmitted": "貼上內容中間省略 {{count}} 行",
  "remote.toolCall.filesystem.copyFormatPending":
    "已排隊等待 Prettier 自動格式化",

  "remote.toolCall.filesystem.copyCut": "剪下",
  "remote.toolCall.filesystem.copyCutPasted":
    "已剪下至第 {{start}}-{{end}} 行，共 {{total}} 行",
  "remote.toolCall.filesystem.copyCutCount": "已剪下 {{count}} 行",
  "remote.toolCall.filesystem.copyMoveSameFile":
    "同檔案內移動，來源區間已從同檔案第 {{start}}-{{end}} 行移除",
  "remote.toolCall.filesystem.copyRemovedSource":
    "來源檔案刪除 {{count}} 行，現共 {{total}} 行",
  "remote.toolCall.filesystem.copyRemovedSourceOnly":
    "來源檔案刪除 {{count}} 行",

  "remote.toolCall.filesystem.copyDelete": "刪除",
  "remote.toolCall.filesystem.copyDeleted":
    "已刪除第 {{start}}-{{end}} 行，現共 {{total}} 行",
  "remote.toolCall.filesystem.copyDeletedCount": "已刪除 {{count}} 行",
};
