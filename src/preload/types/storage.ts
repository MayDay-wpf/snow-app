/** 可迁移的存储位置种类：checkpoint（检查点）| upload（上传图片） */
export type StorageLocationKind = "checkpoint" | "upload";

/** 各存储位置路径信息 */
export type StorageLocations = {
  /** 运行数据库文件绝对路径（~/.snowapp/snowapp.db 或自定义） */
  databasePath: string;
  /** 归档数据库文件绝对路径（~/.snowapp/archive.db，存放归档会话） */
  archiveDbPath: string;
  /** 检查点自定义保存目录（空字符串表示使用默认目录） */
  checkpointDir: string;
  /** 上传图片自定义保存目录（空字符串表示使用默认目录） */
  uploadDir: string;
  /** 检查点根目录绝对路径（优先自定义，回退默认） */
  checkpointRoot: string;
  /** 上传图片根目录绝对路径（优先自定义，回退默认） */
  uploadRoot: string;
};

/** 存储目录迁移进度 */
export type StorageMigrationProgress = {
  copied: number;
  total: number;
  done: boolean;
};

/** 可修复的数据库种类：runtime（运行库）| archive（归档库） */
export type DatabaseKind = "runtime" | "archive";

/** 数据库修复结果 */
export type DatabaseRepairResult = {
  /** 是否实际执行了数据恢复（true=检测到损坏并已恢复；false=数据库完好，仅完成压缩） */
  repaired: boolean;
  /** 修复过程描述（英文，供日志与诊断） */
  message: string;
};

/** 数据库空间优化结果 */
export type DatabaseOptimizeResult = {
  /** 本次 VACUUM + WAL 截断释放的磁盘字节数（无可回收空间时为 0） */
  bytesFreed: number;
};

/** 进程内存整理结果 */
export type MemoryOptimizeResult = {
  /** 本次优化前的常驻内存（字节；含 GC 前的测量值） */
  bytesBefore: number;
  /** 本次优化后的常驻内存（字节） */
  bytesAfter: number;
};
