/**
 * Codex 宠物精灵图引擎。
 *
 * 精灵图几何规范（与 Codex App / Petdex 完全一致）：
 * - 8 列网格，单帧 192×208px；v1 共 9 行（1536×1872），
 *   Hatch Pet v2 共 11 行（1536×2288，后两行 look 扩展态被忽略）。
 * - 行序：idle / running-right / running-left / waving / jumping /
 *         failed / waiting / running / review。
 *
 * 帧数逐行扫描 alpha 自动检测（遇连续 2 个空帧截止），
 * 品红（#FF00FF 附近）背景自动抠图——兼容 ChatGPT Hatch Pet 产物。
 */

/** Codex 精灵图单帧宽度（像素）。 */
export const PET_FRAME_WIDTH = 192;
/** Codex 精灵图单帧高度（像素）。 */
export const PET_FRAME_HEIGHT = 208;

/** 状态 → 精灵图行号（Codex 标准 9 态行序）。 */
export const PET_STATE_ROWS = {
  idle: 0,
  "running-right": 1,
  "running-left": 2,
  waving: 3,
  jumping: 4,
  failed: 5,
  waiting: 6,
  running: 7,
  review: 8,
} as const;

export type PetSpriteState = keyof typeof PET_STATE_ROWS;

/** 各状态播放帧率（fps）。 */
export const PET_STATE_FPS: Record<PetSpriteState, number> = {
  idle: 6,
  "running-right": 5,
  "running-left": 5,
  waving: 8,
  jumping: 9,
  failed: 8,
  waiting: 7,
  running: 5,
  review: 9,
};

/** 精灵图预处理结果。 */
export type PreparedSpritesheet = {
  /** 已抠图的离屏画布 */
  canvas: HTMLCanvasElement;
  /** 每行有效帧数（仅前 9 行） */
  frameCounts: number[];
  /** 单帧宽度（像素） */
  frameWidth: number;
  /** 单帧高度（像素） */
  frameHeight: number;
};

const ALPHA_SAMPLE_STRIDE = 6;
const EMPTY_ALPHA_THRESHOLD = 8;

/** 判断单元格内是否存在非透明像素（步进采样）。 */
const cellHasContent = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.ceil(x + width);
  const y1 = Math.ceil(y + height);
  if (x1 <= x0 || y1 <= y0) {
    return false;
  }
  const imageData = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  const data = imageData.data;
  const rowStride = imageData.width * 4;
  for (let py = 0; py < imageData.height; py += ALPHA_SAMPLE_STRIDE) {
    for (let px = 0; px < imageData.width; px += ALPHA_SAMPLE_STRIDE) {
      if (data[py * rowStride + px * 4 + 3] > EMPTY_ALPHA_THRESHOLD) {
        return true;
      }
    }
  }
  return false;
};

/**
 * 加载并预处理精灵图：品红抠图 + 逐行帧数检测。
 * rows 上限取 9（忽略 v2 的 look 扩展态）。
 */
export const prepareSpritesheet = (
  image: HTMLImageElement,
  columns: number,
  rows: number,
): PreparedSpritesheet => {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Canvas 2D context is unavailable");
  }
  ctx.drawImage(image, 0, 0);

  // ── 品红背景抠图（Hatch Pet 产物常见 #FF00FF 背景）─────────────────
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r > 180 && g < 90 && b > 180) {
      data[i + 3] = 0;
    }
  }
  ctx.putImageData(imageData, 0, 0);

  // ── 逐行检测有效帧数 ───────────────────────────────────────────────
  const usableRows = Math.min(rows, 9);
  const frameWidth = image.naturalWidth / columns;
  const frameHeight = image.naturalHeight / rows;
  const frameCounts: number[] = [];
  for (let row = 0; row < usableRows; row += 1) {
    let count = 0;
    let emptyRun = 0;
    for (let col = 0; col < columns; col += 1) {
      const hasContent = cellHasContent(
        ctx,
        col * frameWidth,
        row * frameHeight,
        frameWidth,
        frameHeight,
      );
      if (hasContent) {
        emptyRun = 0;
        count = col + 1;
      } else {
        emptyRun += 1;
        if (emptyRun >= 2) {
          break;
        }
      }
    }
    frameCounts.push(Math.max(count, 1));
  }

  return { canvas, frameCounts, frameWidth, frameHeight };
};
