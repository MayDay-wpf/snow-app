/** 图像管理系统（生成图片图库）记录 */
export type ImageLibraryRecord = {
  id: string;
  relativePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  prompt: string;
  model: string;
  provider: string;
  createdAt: string;
  /** 所属相册 id；null = 未分类 */
  albumId: string | null;
};

/** 图库相册记录 */
export type ImageAlbumRecord = {
  id: string;
  name: string;
  createdAt: string;
  /** 相册封面：最新一张图的图库相对路径（image/...）；空相册为 null */
  coverPath: string | null;
  /** 相册内图片数量 */
  imageCount: number;
};

/** 图库目录迁移进度 */
export type ImageLibraryMigrationProgress = {
  copied: number;
  total: number;
  done: boolean;
};
