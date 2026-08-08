import { ipcRenderer } from "electron";
import type {
  ImageAlbumRecord,
  ImageLibraryMigrationProgress,
  ImageLibraryRecord,
} from "../types/imageLibrary";

/** 图像管理系统（Image Library）API。 */
export const imageLibraryApi = {
  /** 图库根目录绝对路径（优先用户自定义路径，回退默认 ~/.snowapp/image） */
  getImageLibraryRoot: (): Promise<string> =>
    ipcRenderer.invoke("images:library-root"),

  /** 读取图库自定义保存目录（空字符串表示使用默认目录） */
  getImageLibraryDir: (): Promise<string> =>
    ipcRenderer.invoke("images:library-dir-get"),

  /** 设置图库自定义保存目录（传入空字符串重置为默认目录） */
  setImageLibraryDir: (dir: string): Promise<void> =>
    ipcRenderer.invoke("images:library-dir-set", dir),

  /** 弹出目录选择对话框，返回选中目录路径或 null */
  selectImageDirectory: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke("images:select-directory", dialogTitle),

  /** 列出全部生成图片（按创建时间倒序） */
  listImageLibrary: (): Promise<ImageLibraryRecord[]> =>
    ipcRenderer.invoke("images:library-list"),

  /** 删除图片：物理文件 + 索引 + 同步重写引用该图的会话消息 */
  deleteImageLibraryImage: (id: string): Promise<void> =>
    ipcRenderer.invoke("images:library-delete", id),

  /** 把图库相对路径（image/...）解析为 data URL，失败返回 null */
  resolveLibraryImage: (relativePath: string): Promise<string | null> =>
    ipcRenderer.invoke("images:resolve-library-image", relativePath),

  /** 统计指定会话中引用的图库图片数量（删除会话确认框用） */
  countConversationImages: (conversationIds: string[]): Promise<number> =>
    ipcRenderer.invoke("images:conversation-images-count", conversationIds),

  /** 级联删除指定会话中引用的图库图片（删除会话时选择不保留图片） */
  deleteConversationImages: (conversationIds: string[]): Promise<number> =>
    ipcRenderer.invoke("images:delete-conversation-images", conversationIds),

  /** 准备图库迁移：校验目标目录并写入迁移日志；返回待迁移图片数量（0 表示无需迁移） */
  prepareImageLibraryMigration: (targetDir: string): Promise<number> =>
    ipcRenderer.invoke("images:library-migrate-prepare", targetDir),

  /** 复制下一批图库文件并返回迁移进度（copied/total/done） */
  migrateImageLibraryChunk: (): Promise<ImageLibraryMigrationProgress> =>
    ipcRenderer.invoke("images:library-migrate-chunk"),

  /** 提交迁移：写入新目录设置并清理旧根目录文件 */
  commitImageLibraryMigration: (): Promise<void> =>
    ipcRenderer.invoke("images:library-migrate-commit"),

  /** 回滚迁移：删除已复制到新目录的文件并移除日志（幂等） */
  rollbackImageLibraryMigration: (): Promise<void> =>
    ipcRenderer.invoke("images:library-migrate-rollback"),

  /** 列出全部相册（按创建时间倒序），含封面路径与图片数量 */
  listImageAlbums: (): Promise<ImageAlbumRecord[]> =>
    ipcRenderer.invoke("images:album-list"),

  /** 创建相册；名称去空白、不允许为空 */
  createImageAlbum: (name: string): Promise<ImageAlbumRecord> =>
    ipcRenderer.invoke("images:album-create", name),

  /** 重命名相册 */
  renameImageAlbum: (id: string, name: string): Promise<ImageAlbumRecord> =>
    ipcRenderer.invoke("images:album-rename", id, name),

  /** 删除相册：相册内图片保留（移入未分类） */
  deleteImageAlbum: (id: string): Promise<void> =>
    ipcRenderer.invoke("images:album-delete", id),

  /** 将图片移入 / 移出相册（albumId 传 null 表示移出到未分类） */
  setImageAlbum: (imageId: string, albumId: string | null): Promise<void> =>
    ipcRenderer.invoke("images:album-set-image", imageId, albumId),

  /** 弹出图片文件选择对话框（多选），返回选中文件路径数组或 null */
  selectImageFiles: (dialogTitle?: string): Promise<string[] | null> =>
    ipcRenderer.invoke("images:select-images", dialogTitle),

  /** 手动导入图片文件到图库（复制 + 写索引），返回成功导入的记录 */
  importImageFiles: (filePaths: string[]): Promise<ImageLibraryRecord[]> =>
    ipcRenderer.invoke("images:import-images", filePaths),
};
