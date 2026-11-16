import { app, ipcMain, BrowserWindow, dialog } from "electron";
import { writeFile } from "fs/promises";
import { join } from "path";
import type { NativeBridge } from "../../native/types";
import { readImageSource } from "../../app/imageProxyProtocol";

/** 按图片 MIME 推断保存扩展名，未知类型回退为 png。 */
const extensionForMime = (mimeType: string): string => {
  const lower = mimeType.toLowerCase();
  if (lower.includes("webp")) {
    return "webp";
  }
  if (lower.includes("jpeg") || lower.includes("jpg")) {
    return "jpg";
  }
  if (lower.includes("gif")) {
    return "gif";
  }
  if (lower.includes("svg")) {
    return "svg";
  }
  return "png";
};

/**
 * 图像管理系统（Image Library）IPC。
 *
 * - `images:library-root`：图库根目录绝对路径（~/.snowapp/image）
 * - `images:library-dir-get`：读取图库自定义保存目录
 * - `images:library-dir-set`：设置图库自定义保存目录
 * - `images:select-directory`：弹出目录选择对话框
 * - `images:library-list`：列出全部生成图片（按时间倒序）
 * - `images:library-delete`：删除图片（物理文件 + 索引 + 同步重写会话消息）
 * - `images:resolve-library-image`：把 image/ 相对路径解析为 data URL
 * - `images:read-source`：把任意图片来源（data / img-proxy / http(s)）读为 data URL
 * - `images:save-sources`：原生对话框保存图片（单张选文件，多张选目录）
 */
export const registerImageLibraryHandlers = (native: NativeBridge): void => {
  ipcMain.handle(
    "images:read-source",
    async (_event, src: unknown): Promise<string> => {
      if (typeof src !== "string" || src.trim() === "") {
        throw new Error("Invalid image source");
      }
      const { bytes, mimeType } = await readImageSource(src.trim(), native);
      return `data:${mimeType};base64,${bytes.toString("base64")}`;
    },
  );

  ipcMain.handle(
    "images:save-sources",
    async (event, sources: unknown): Promise<number> => {
      if (!Array.isArray(sources)) {
        throw new Error("Invalid image sources");
      }
      const safeSources = sources.filter(
        (src): src is string => typeof src === "string" && src.trim() !== "",
      );
      // 先读取全部图片（单张失败跳过），扩展名据真实 MIME 决定
      const images: { bytes: Buffer; extension: string }[] = [];
      for (const src of safeSources) {
        try {
          const { bytes, mimeType } = await readImageSource(src.trim(), native);
          images.push({ bytes, extension: extensionForMime(mimeType) });
        } catch (error) {
          console.warn("[images:save-sources] read failed:", error);
        }
      }
      if (images.length === 0) {
        throw new Error("No readable image to save");
      }

      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const base = `snow-app-${Date.now()}`;

      if (images.length === 1) {
        const [image] = images;
        const options: Electron.SaveDialogOptions = {
          defaultPath: join(
            app.getPath("downloads"),
            `${base}.${image.extension}`,
          ),
          filters: [{ name: "Image", extensions: [image.extension] }],
        };
        const result = browserWindow
          ? await dialog.showSaveDialog(browserWindow, options)
          : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) {
          return 0;
        }
        await writeFile(result.filePath, image.bytes);
        return 1;
      }

      const options: Electron.OpenDialogOptions = {
        defaultPath: app.getPath("downloads"),
        properties: ["openDirectory", "createDirectory"],
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);
      const dir = result.canceled ? null : result.filePaths[0];
      if (!dir) {
        return 0;
      }
      for (let i = 0; i < images.length; i++) {
        await writeFile(
          join(dir, `${base}-${i + 1}.${images[i].extension}`),
          images[i].bytes,
        );
      }
      return images.length;
    },
  );

  ipcMain.handle("images:library-root", async (): Promise<string> => {
    return native.getImageLibraryRoot();
  });

  ipcMain.handle("images:library-dir-get", async (): Promise<string> => {
    return native.getImageLibraryDir();
  });

  ipcMain.handle(
    "images:library-dir-set",
    async (_event, dir: unknown): Promise<void> => {
      if (typeof dir !== "string") {
        throw new Error("Invalid image library directory");
      }
      await native.setImageLibraryDir(dir.trim());
    },
  );

  ipcMain.handle(
    "images:select-directory",
    async (event, dialogTitle: unknown): Promise<string | null> => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const title =
        typeof dialogTitle === "string" && dialogTitle.trim()
          ? dialogTitle.trim()
          : "Select image library directory";
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ["openDirectory"],
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );

  ipcMain.handle("images:library-list", async (): Promise<unknown> => {
    return native.listImageLibrary();
  });

  ipcMain.handle(
    "images:library-delete",
    async (_event, id: unknown): Promise<void> => {
      if (typeof id !== "string" || id.trim() === "") {
        throw new Error("Invalid image library id");
      }
      await native.deleteImageLibraryImage(id.trim());
    },
  );

  ipcMain.handle(
    "images:resolve-library-image",
    async (_event, relativePath: unknown): Promise<string | null> => {
      if (typeof relativePath !== "string") {
        return null;
      }
      return native.readImageLibraryFile(relativePath.trim());
    },
  );

  ipcMain.handle(
    "images:conversation-images-count",
    async (_event, conversationIds: unknown): Promise<number> => {
      if (!Array.isArray(conversationIds)) {
        return 0;
      }
      const safeIds = conversationIds.filter(
        (id): id is string => typeof id === "string" && id.trim() !== "",
      );
      if (safeIds.length === 0) {
        return 0;
      }
      return native.countConversationImages(safeIds);
    },
  );

  ipcMain.handle(
    "images:delete-conversation-images",
    async (_event, conversationIds: unknown): Promise<number> => {
      if (!Array.isArray(conversationIds)) {
        return 0;
      }
      const safeIds = conversationIds.filter(
        (id): id is string => typeof id === "string" && id.trim() !== "",
      );
      if (safeIds.length === 0) {
        return 0;
      }
      return native.deleteConversationImages(safeIds);
    },
  );

  ipcMain.handle(
    "images:library-migrate-prepare",
    async (_event, targetDir: unknown): Promise<number> => {
      if (typeof targetDir !== "string") {
        throw new Error("Invalid image library target directory");
      }
      return native.prepareImageLibraryMigration(targetDir.trim());
    },
  );

  ipcMain.handle("images:library-migrate-chunk", async (): Promise<unknown> => {
    return native.migrateImageLibraryChunk();
  });

  ipcMain.handle("images:library-migrate-commit", async (): Promise<void> => {
    await native.commitImageLibraryMigration();
  });

  ipcMain.handle("images:library-migrate-rollback", async (): Promise<void> => {
    await native.rollbackImageLibraryMigration();
  });

  // ---- 相册（Album）----

  ipcMain.handle("images:album-list", async (): Promise<unknown> => {
    return native.listImageAlbums();
  });

  ipcMain.handle(
    "images:album-create",
    async (_event, name: unknown): Promise<unknown> => {
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error("Album name must not be empty");
      }
      return native.createImageAlbum(name.trim());
    },
  );

  ipcMain.handle(
    "images:album-rename",
    async (_event, id: unknown, name: unknown): Promise<unknown> => {
      if (typeof id !== "string" || id.trim() === "") {
        throw new Error("Invalid album id");
      }
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error("Album name must not be empty");
      }
      return native.renameImageAlbum(id.trim(), name.trim());
    },
  );

  ipcMain.handle(
    "images:album-delete",
    async (_event, id: unknown): Promise<void> => {
      if (typeof id !== "string" || id.trim() === "") {
        throw new Error("Invalid album id");
      }
      await native.deleteImageAlbum(id.trim());
    },
  );

  ipcMain.handle(
    "images:album-set-image",
    async (_event, imageId: unknown, albumId: unknown): Promise<void> => {
      if (typeof imageId !== "string" || imageId.trim() === "") {
        throw new Error("Invalid image id");
      }
      if (albumId !== null && typeof albumId !== "string") {
        throw new Error("Invalid album id");
      }
      const normalizedAlbumId =
        typeof albumId === "string" && albumId.trim() !== ""
          ? albumId.trim()
          : null;
      await native.setImageAlbum(imageId.trim(), normalizedAlbumId);
    },
  );

  ipcMain.handle(
    "images:album-set-cover",
    async (_event, albumId: unknown, imageId: unknown): Promise<unknown> => {
      if (typeof albumId !== "string" || albumId.trim() === "") {
        throw new Error("Invalid album id");
      }
      if (imageId !== null && typeof imageId !== "string") {
        throw new Error("Invalid image id");
      }
      const normalizedImageId =
        typeof imageId === "string" && imageId.trim() !== ""
          ? imageId.trim()
          : null;
      return native.setImageAlbumCover(albumId.trim(), normalizedImageId);
    },
  );

  ipcMain.handle(
    "images:album-reorder",
    async (_event, orderedIds: unknown): Promise<void> => {
      if (
        !Array.isArray(orderedIds) ||
        orderedIds.some((id) => typeof id !== "string" || id.trim() === "")
      ) {
        throw new Error("Invalid album id list");
      }
      await native.reorderImageAlbums(
        orderedIds.map((id) => (id as string).trim()),
      );
    },
  );

  ipcMain.handle(
    "images:select-images",
    async (event, dialogTitle: unknown): Promise<string[] | null> => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const title =
        typeof dialogTitle === "string" && dialogTitle.trim()
          ? dialogTitle.trim()
          : "Select images to import";
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ["openFile", "multiSelections"],
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
          },
        ],
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths;
    },
  );

  ipcMain.handle(
    "images:import-images",
    async (_event, filePaths: unknown): Promise<unknown> => {
      if (!Array.isArray(filePaths)) {
        throw new Error("Invalid image file paths");
      }
      const safePaths = filePaths.filter(
        (path): path is string =>
          typeof path === "string" && path.trim() !== "",
      );
      return native.importImageFiles(safePaths);
    },
  );
};
