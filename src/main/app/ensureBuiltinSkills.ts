import { app } from "electron";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { snowLog } from "../../utils/snowLogger";

const SKILLS_DIR_NAME = "skills";
const DOCS_DIR_NAME = "docs";
const SKILL_FILE_NAME = "SKILL.md";
const DOCS_VERSION_FILE_NAME = ".snow-docs-version";
/** 内置 skills 同步版本标记（位于 ~/.snow/skills/ 内，记录应用版本）。 */
const SKILLS_VERSION_FILE_NAME = ".snow-skills-version";

/**
 * 应用内置资源的源目录。
 * - 开发模式：项目根目录下的 resources/skills、docs
 * - 打包后：app.asar 内的 resources/skills、docs（electron-builder files 配置）
 */
const builtinSourceDir = (dirName: string): string =>
  join(app.getAppPath(), dirName);

/**
 * 用户全局目录（~/.snow），load_available_skills 会读取其中的 skills/。
 */
const userSnowDir = (): string => join(homedir(), ".snow");

/**
 * 递归复制目录。刻意只使用 readdirSync / copyFileSync / mkdirSync，
 * 不使用 cpSync，确保打包后从 app.asar 内复制资源也能正常工作
 * （Electron 对这三者做了透明的 asar 支持）。
 */
const copyDirRecursive = (sourceDir: string, targetDir: string): void => {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(sourcePath, targetPath);
    } else {
      copyFileSync(sourcePath, targetPath);
    }
  }
};

/** 读取 SKILL.md frontmatter 的 enable 开关（未显式声明时返回 null）。 */
const readEnableFlag = (file: string): boolean | null => {
  try {
    const content = readFileSync(file, "utf8");
    const match = content.match(/^enable:\s*(true|false)\s*$/m);
    return match ? match[1] === "true" : null;
  } catch {
    return null;
  }
};

/** 写回 SKILL.md frontmatter 的 enable 开关（未显式声明时保持原样）。 */
const writeEnableFlag = (file: string, enabled: boolean): void => {
  try {
    const content = readFileSync(file, "utf8");
    const updated = content.replace(
      /^enable:\s*(true|false)\s*$/m,
      `enable: ${enabled}`
    );
    if (updated !== content) {
      writeFileSync(file, updated, "utf8");
    }
  } catch {
    // 写回失败不影响同步本身
  }
};

/**
 * 把应用内置 skills（resources/skills/<id>/SKILL.md）同步到用户目录
 * ~/.snow/skills/<id>/SKILL.md，使用户能看到并能在 Skills 设置中开关。
 *
 * 同步触发条件：首次安装（版本标记缺失）、应用升级（版本变化），或
 * 开发模式（内置 skill 内容随代码迭代，每次启动即时生效）。同步时只
 * 覆盖内置 skill 目录，绝不触碰用户自装或其他来源的 skill；同时保留
 * 用户在设置里对内置 skill 的启用/禁用开关（覆盖后写回 frontmatter
 * 的 enable）。用户对内置 skill 文件本身的编辑会在同步时被官方版本
 * 覆盖（与内置文档升级语义一致）。
 */
export const ensureBuiltinSkills = (): void => {
  const sourceRoot = builtinSourceDir(join("resources", SKILLS_DIR_NAME));

  let skillIds: string[];
  try {
    skillIds = readdirSync(sourceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    // 打包时资源缺失不应阻断启动，记录后跳过。
    snowLog.warn({
      module: "app/skills",
      func: "ensureBuiltinSkills",
      message: "Builtin skills source dir not found, skipping sync",
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const skillsDir = join(userSnowDir(), SKILLS_DIR_NAME);
  const versionFile = join(skillsDir, SKILLS_VERSION_FILE_NAME);
  const currentVersion = app.getVersion();

  // 是否需要同步：标记缺失或版本变化（正式发布推送），或开发模式
  // （内容随代码迭代，每次启动即时生效）。
  let versionChanged = true;
  try {
    versionChanged =
      !existsSync(versionFile) ||
      readFileSync(versionFile, "utf8").trim() !== currentVersion;
  } catch {
    versionChanged = true;
  }
  if (!versionChanged && app.isPackaged) {
    return;
  }

  let synced = 0;
  let failed = 0;
  for (const skillId of skillIds) {
    const sourceFile = join(sourceRoot, skillId, SKILL_FILE_NAME);
    if (!existsSync(sourceFile)) {
      continue;
    }

    const targetDir = join(skillsDir, skillId);
    const targetFile = join(targetDir, SKILL_FILE_NAME);

    try {
      // 保留用户开关：覆盖前读取目标 frontmatter 的 enable 状态，覆盖后
      // 写回，避免自动推送把用户在设置里的启用/禁用重置为官方默认。
      const userEnable = existsSync(targetFile)
        ? readEnableFlag(targetFile)
        : null;
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(sourceFile, targetFile);
      if (userEnable !== null) {
        writeEnableFlag(targetFile, userEnable);
      }
      synced++;
    } catch (error) {
      failed++;
      snowLog.warn({
        module: "app/skills",
        func: "ensureBuiltinSkills",
        message: `Failed to sync builtin skill: ${skillId}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 同步成功后记录版本（源为空时跳过，避免把空同步固化为已同步状态）。
  if (skillIds.length > 0) {
    try {
      writeFileSync(versionFile, currentVersion, "utf8");
    } catch (error) {
      snowLog.warn({
        module: "app/skills",
        func: "ensureBuiltinSkills",
        message: "Failed to write builtin skills version marker",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  snowLog.info({
    module: "app/skills",
    func: "ensureBuiltinSkills",
    message: `Builtin skills synced (${synced} synced, ${failed} failed)`,
    context: `${sourceRoot} -> ${skillsDir}`,
  });
};

/**
 * 把应用内置文档（项目根 docs/）同步到用户目录 ~/.snow/docs/，供
 * snow-app-docs 技能引导 Agent 阅读。
 *
 * 使用标记文件 `.snow-docs-version` 记录同步时的应用版本：仅当标记缺失
 * 或应用版本变化时整树重同步（先删后复制），避免每次启动重复覆盖；
 * 用户若自行修改 ~/.snow/docs/ 中的文档，会在应用升级时被新版覆盖。
 */
export const ensureBuiltinDocs = (): void => {
  const sourceDir = builtinSourceDir(DOCS_DIR_NAME);
  if (!existsSync(sourceDir)) {
    snowLog.warn({
      module: "app/skills",
      func: "ensureBuiltinDocs",
      message: "Builtin docs source dir not found, skipping sync",
      context: sourceDir,
    });
    return;
  }

  const targetDir = join(userSnowDir(), DOCS_DIR_NAME);
  const versionFile = join(targetDir, DOCS_VERSION_FILE_NAME);
  const currentVersion = app.getVersion();

  try {
    if (
      existsSync(versionFile) &&
      readFileSync(versionFile, "utf8").trim() === currentVersion
    ) {
      return;
    }

    // 版本变化或首次安装：整树重同步（仅操作 ~/.snow/docs，绝不泛化删除）。
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    copyDirRecursive(sourceDir, targetDir);
    writeFileSync(versionFile, currentVersion, "utf8");

    snowLog.info({
      module: "app/skills",
      func: "ensureBuiltinDocs",
      message: "Builtin docs synced",
      context: `${sourceDir} -> ${targetDir} (version ${currentVersion})`,
    });
  } catch (error) {
    snowLog.warn({
      module: "app/skills",
      func: "ensureBuiltinDocs",
      message: "Failed to sync builtin docs",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
