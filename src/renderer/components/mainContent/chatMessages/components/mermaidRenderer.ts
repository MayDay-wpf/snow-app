/**
 * Mermaid diagram renderer (main-thread only).
 *
 * Mermaid needs DOM access, so it cannot run inside the markdown Web Worker.
 * The worker emits placeholder containers (`.mermaid-block[data-mermaid]`)
 * carrying the escaped diagram source. This module lazily imports mermaid and
 * renders each placeholder into an SVG, with:
 *
 * - A two-phase render cycle: synchronous cache injection (via useLayoutEffect)
 *   prevents flash on re-render, while async rendering handles uncached sources.
 * - Failure-tolerant streaming: when mermaid.parse fails on incomplete code
 *   during streaming, the error is silently ignored — the code view stays
 *   visible and the render is retried on the next content update. No error
 *   states are shown, eliminating flicker.
 * - A render cache keyed by source string (theme-tagged) so finalized diagrams
 *   are not re-parsed on every React re-render.
 * - Theme awareness: re-renders all visible diagrams when the global
 *   `data-theme` attribute changes (light <-> dark).
 * - Code/diagram view toggle with per-source preference tracking.
 */

/** Selector for placeholder containers emitted by the worker. */
const MERMAID_SELECTOR = ".mermaid-block[data-mermaid]";

/** Attribute set on a placeholder once it has been rendered for a given theme. */
const RENDERED_ATTR = "data-mermaid-rendered";

/** Attribute controlling which view (code/diagram) is visible. */
const VIEW_ATTR = "data-mermaid-view";

const isDarkTheme = (): boolean =>
  document.documentElement.getAttribute("data-theme") === "dark";

const currentThemeKey = (): string => (isDarkTheme() ? "dark" : "light");

const RENDER_TIMEOUT_MS = 10000;
const IMPORT_TIMEOUT_MS = 15000;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });

const delay = (ms = 200): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

const safeDecode = (value: string | null): string => {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// ---------------------------------------------------------------------------
// SVG render cache
// ---------------------------------------------------------------------------

/** Cache entry: the rendered SVG and the theme it was rendered for. */
type CacheEntry = { svg: string; theme: string };

const svgCache = new Map<string, CacheEntry>();

const cacheSet = (key: string, value: CacheEntry): void => {
  if (svgCache.size >= 64) {
    const oldest = svgCache.keys().next().value;
    if (oldest !== undefined) svgCache.delete(oldest);
  }
  svgCache.set(key, value);
};

// ---------------------------------------------------------------------------
// View preference tracking (survives innerHTML replacement)
// ---------------------------------------------------------------------------

/**
 * Per-source view preference. When the user explicitly chooses "code", we
 * respect that choice even after a successful render. Keyed by source string.
 */
const viewPreferences = new Map<string, "code" | "diagram">();

// ---------------------------------------------------------------------------
// Mermaid lazy import
// ---------------------------------------------------------------------------

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
let initializedTheme: string | null = null;

const getMermaid = async (): Promise<typeof import("mermaid").default> => {
  if (!mermaidPromise) {
    mermaidPromise = withTimeout(import("mermaid"), IMPORT_TIMEOUT_MS).then(
      (mod) => {
        const mermaid = mod.default;
        const theme = currentThemeKey();
        mermaid.initialize({
          startOnLoad: false,
          theme: theme === "dark" ? "dark" : "default",
          securityLevel: "strict",
          fontFamily: "inherit",
        });
        initializedTheme = theme;
        return mermaid;
      },
    );
  }
  return mermaidPromise;
};

const ensureTheme = async (
  mermaid: typeof import("mermaid").default,
): Promise<void> => {
  const theme = currentThemeKey();
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      theme: theme === "dark" ? "dark" : "default",
      securityLevel: "strict",
      fontFamily: "inherit",
    });
    initializedTheme = theme;
  }
};

// ---------------------------------------------------------------------------
// Render coordination
// ---------------------------------------------------------------------------

let renderIdCounter = 0;

/** Serialize Mermaid renders so separate Markdown blocks do not cancel each other. */
let mermaidRenderQueue: Promise<void> = Promise.resolve();

const enqueueMermaidRender = (task: () => Promise<void>): Promise<void> => {
  const next = mermaidRenderQueue.then(task, task);
  mermaidRenderQueue = next.catch(() => undefined);
  return next;
};

let catchUpScheduled = false;

const scheduleCatchUpScan = (): void => {
  if (catchUpScheduled) return;
  catchUpScheduled = true;
  window.setTimeout(() => {
    catchUpScheduled = false;
    void renderMermaidBlocks(document);
  }, 300);
};

/**
 * Apply the cached SVG (if any) to a single block and set the view mode.
 * Returns true if a cache hit was applied.
 */
const applyCache = (
  block: HTMLElement,
  source: string,
  themeKey: string,
): boolean => {
  const entry = svgCache.get(source);
  if (!entry || entry.theme !== themeKey) return false;

  const diagramView = block.querySelector<HTMLElement>(".mermaid-view-diagram");
  if (!diagramView) return false;
  diagramView.innerHTML = entry.svg;
  block.setAttribute(RENDERED_ATTR, themeKey);

  const pref = viewPreferences.get(source) ?? "diagram";
  block.setAttribute(VIEW_ATTR, pref);
  return true;
};

/**
 * Synchronously inject cached SVGs into all mermaid placeholders within `root`.
 *
 * Call this from useLayoutEffect (before browser paint) so that already-rendered
 * diagrams appear instantly after innerHTML replacement — no flash.
 */
export const injectCachedDiagrams = (root: ParentNode): void => {
  const blocks = root.querySelectorAll<HTMLElement>(MERMAID_SELECTOR);
  if (blocks.length === 0) return;

  const themeKey = currentThemeKey();
  blocks.forEach((block) => {
    const source = safeDecode(block.getAttribute("data-mermaid"));
    applyCache(block, source, themeKey);
  });
};

/**
 * Asynchronously render uncached mermaid blocks.
 *
 * On failure (incomplete code during streaming, syntax errors, etc.) the error
 * is silently ignored — no error state is shown, no DOM is replaced. The code
 * view remains visible and the render is retried when content changes.
 */
const renderMermaidWithRetry = async (
  mermaid: typeof import("mermaid").default,
  source: string,
): Promise<{ svg: string; id: string }> => {
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const id = `mmd-${renderIdCounter++}`;
    try {
      const result = await withTimeout(
        mermaid.render(id, source),
        RENDER_TIMEOUT_MS,
      );
      return { svg: result.svg, id };
    } catch (error) {
      document.getElementById(id)?.remove();
      lastError = error;
      if (attempt === 0) {
        await delay();
      }
    }
  }

  throw lastError;
};

/** Render Mermaid blocks one at a time to avoid shared runtime state conflicts. */
export const renderMermaidBlocks = (root: ParentNode): Promise<void> =>
  enqueueMermaidRender(async () => {
    const blocks = root.querySelectorAll<HTMLElement>(MERMAID_SELECTOR);
    if (blocks.length === 0) return;

    let mermaid: typeof import("mermaid").default;
    try {
      mermaid = await getMermaid();
      await ensureTheme(mermaid);
    } catch {
      mermaidPromise = null;
      initializedTheme = null;
      return;
    }

    const themeKey = currentThemeKey();
    const pending: { block: HTMLElement; source: string }[] = [];

    blocks.forEach((block) => {
      if (block.getAttribute(RENDERED_ATTR) === themeKey) return;

      const source = safeDecode(block.getAttribute("data-mermaid"));
      if (applyCache(block, source, themeKey)) return;
      pending.push({ block, source });
    });

    for (const { block, source } of pending) {
      if (!block.isConnected) continue;

      try {
        const { svg, id } = await renderMermaidWithRetry(mermaid, source);

        cacheSet(source, { svg, theme: themeKey });

        if (!block.isConnected) {
          document.getElementById(id)?.remove();
          scheduleCatchUpScan();
          continue;
        }

        const diagramView = block.querySelector<HTMLElement>(
          ".mermaid-view-diagram",
        );
        if (diagramView) {
          diagramView.innerHTML = svg;
        }
        block.setAttribute(RENDERED_ATTR, themeKey);

        if (viewPreferences.get(source) !== "code") {
          block.setAttribute(VIEW_ATTR, "diagram");
        }
      } catch {
        // Keep the source view visible when Mermaid rejects incomplete or invalid syntax.
      }
    }
  });

// ---------------------------------------------------------------------------
// View toggle
// ---------------------------------------------------------------------------

/**
 * Toggle a mermaid block between code and diagram views.
 * Stores the preference so it survives innerHTML replacement.
 *
 * Switching to "diagram" is rejected if the SVG hasn't been rendered yet.
 */
export const setMermaidView = (
  block: HTMLElement,
  view: "code" | "diagram",
): void => {
  if (view === "diagram" && !block.hasAttribute(RENDERED_ATTR)) return;

  const source = safeDecode(block.getAttribute("data-mermaid"));
  viewPreferences.set(source, view);
  block.setAttribute(VIEW_ATTR, view);
};

// ---------------------------------------------------------------------------
// Export (save as SVG / PNG / JPG)
// ---------------------------------------------------------------------------

/** Supported export formats. */
export type MermaidExportFormat = "svg" | "png" | "jpg";

/** Default pixel scale for raster exports (2x for retina-quality output). */
const EXPORT_SCALE = 2;
/** Background fill for JPG (opaque) and PNG (when the SVG has none). */
const EXPORT_BG = isDarkTheme() ? "#1a1a1a" : "#ffffff";

/**
 * Extract the `<svg>` element rendered inside a mermaid block's diagram view.
 * Returns null if the diagram has not been rendered yet.
 */
const getBlockSvg = (block: HTMLElement): SVGSVGElement | null => {
  const diagramView = block.querySelector<HTMLElement>(".mermaid-view-diagram");
  if (!diagramView) return null;
  return diagramView.querySelector("svg");
};

/** Serialize an SVG element to a standalone XML string with XML declaration. */
const serializeSvg = (svg: SVGSVGElement): string => {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  // Ensure xmlns is present so the file is self-contained.
  if (!clone.getAttribute("xmlns")) {
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(
    clone,
  )}`;
};

/** Trigger a browser download for a Blob with the given filename. */
const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** Save a file using the native file picker when available, falling back to download. */
const saveFile = async (
  blob: Blob,
  filename: string,
  mimeTypes: string[],
): Promise<void> => {
  // showSaveFilePicker is available in Electron (Chromium-based) and modern browsers.
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (opts: {
        suggestedName?: string;
        types: { description?: string; accept: Record<string, string[]> }[];
      }) => Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;

  if (typeof picker === "function") {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [
          {
            description: "Image file",
            accept: { [mimeTypes[0]]: mimeTypes },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch {
      // User cancelled the picker or the write failed — fall back to download.
    }
  }
  downloadBlob(blob, filename);
};

/**
 * Get the natural (intrinsic) dimensions of an SVG element from its viewBox.
 *
 * Mermaid SVGs carry a `viewBox` that represents the true vector bounds. The
 * `width`/`height` attributes are often set to the rendered (possibly
 * CSS-constrained) display size and may be inaccurate (e.g. a horizontal
 * flowchart shown at a small width with `max-width:100%`). Using viewBox as
 * the authoritative source ensures the exported raster matches the real
 * aspect ratio and full resolution.
 */
const getSvgDimensions = (
  svg: SVGSVGElement,
): { width: number; height: number } => {
  const viewBox = svg.viewBox.baseVal;
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
    return { width: viewBox.width, height: viewBox.height };
  }

  // Fallback: bounding client rect (CSS layout size).
  const rect = svg.getBoundingClientRect();
  const width = rect.width || svg.clientWidth || 0;
  const height = rect.height || svg.clientHeight || 0;
  return { width: Math.max(width, 1), height: Math.max(height, 1) };
};

/**
 * Build a standalone SVG string with explicit width/height so that when loaded
 * into an Image element it renders at its natural vector resolution — not the
 * possibly CSS-constrained display size.
 */
const serializeSvgForRaster = (svg: SVGSVGElement): string => {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const { width, height } = getSvgDimensions(svg);

  if (!clone.getAttribute("xmlns")) {
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  // Force explicit pixel dimensions and remove any CSS that might constrain
  // the rendered size (e.g. max-width:100%, width:auto).
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.removeAttribute("style");

  return new XMLSerializer().serializeToString(clone);
};

/** Rasterize an SVG element to a canvas at the given format and scale. */
const rasterizeSvg = (
  svg: SVGSVGElement,
  format: "png" | "jpg",
  scale: number,
): Promise<HTMLCanvasElement> => {
  const { width, height } = getSvgDimensions(svg);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get 2D canvas context");

  // Fill background for JPG (no transparency support) and as a fallback for PNG.
  if (format === "jpg") {
    ctx.fillStyle = EXPORT_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Use a data: URL instead of a blob: URL — the app's CSP allows img-src
  // data: but not blob:. Encoding the SVG as base64 keeps it CSP-compliant.
  const svgString = serializeSvgForRaster(svg);
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    svgString,
  )}`;

  return new Promise<HTMLCanvasElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Draw at the canvas's pixel dimensions, preserving the SVG aspect ratio.
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    };
    img.onerror = () => {
      reject(new Error("Failed to load SVG into image"));
    };
    img.src = dataUrl;
  });
};

/**
 * Export a mermaid block's diagram to the specified format and save it.
 *
 * SVG is saved as-is. PNG/JPG are rasterized at 2x scale for crisp output.
 * The diagram must have been rendered (SVG present) before calling this.
 */
export const exportMermaid = async (
  block: HTMLElement,
  format: MermaidExportFormat,
  baseName = "mermaid-diagram",
): Promise<void> => {
  const svg = getBlockSvg(block);
  if (!svg) return;

  if (format === "svg") {
    const svgString = serializeSvg(svg);
    const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    await saveFile(blob, `${baseName}.svg`, ["image/svg+xml"]);
    return;
  }

  const canvas = await rasterizeSvg(svg, format, EXPORT_SCALE);
  const mime = format === "png" ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, mime, 0.95),
  );
  if (!blob) return;
  await saveFile(blob, `${baseName}.${format}`, [mime]);
};

// ---------------------------------------------------------------------------
// Export menu (dropdown for format selection)
// ---------------------------------------------------------------------------

/**
 * Open a small dropdown menu anchored to `anchorEl` with SVG / PNG / JPG options.
 * The menu is positioned absolutely and dismissed on outside click or escape.
 *
 * Returns nothing — the caller does not need to manage the menu lifecycle; it
 * self-cleans up on close.
 */
export const openExportMenu = (
  anchorEl: HTMLElement,
  block: HTMLElement,
): void => {
  // Remove any existing export menu first.
  document
    .querySelectorAll(".mermaid-export-menu")
    .forEach((el) => el.remove());

  const menu = document.createElement("div");
  menu.className = "mermaid-export-menu";

  const formats: { format: MermaidExportFormat; label: string }[] = [
    { format: "svg", label: "SVG" },
    { format: "png", label: "PNG" },
    { format: "jpg", label: "JPG" },
  ];

  for (const { format, label } of formats) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "mermaid-export-menu-item";
    item.textContent = label;
    item.addEventListener("click", () => {
      menu.remove();
      void exportMermaid(block, format);
    });
    menu.appendChild(item);
  }

  // Position the menu below the anchor button.
  const rect = anchorEl.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.right}px`;
  menu.style.transform = "translateX(-100%)";

  document.body.appendChild(menu);

  // Dismiss handlers — added after a microtask so the opening click does not
  // immediately close the menu.
  const dismiss = (e: MouseEvent): void => {
    if (menu.contains(e.target as Node)) return;
    menu.remove();
    document.removeEventListener("mousedown", dismiss, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      menu.remove();
      document.removeEventListener("mousedown", dismiss, true);
      document.removeEventListener("keydown", onKey, true);
    }
  };

  setTimeout(() => {
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
};

// ---------------------------------------------------------------------------
// Theme change handling
// ---------------------------------------------------------------------------

/**
 * Re-render all mermaid diagrams in the document after a theme change.
 * Clears the rendered state so all blocks are re-processed for the new theme.
 */
export const refreshAllMermaidOnThemeChange = async (): Promise<void> => {
  // Clear rendered state on all blocks.
  document.querySelectorAll<HTMLElement>(MERMAID_SELECTOR).forEach((block) => {
    block.removeAttribute(RENDERED_ATTR);
  });

  // Inject from cache (entries matching the new theme, if any).
  injectCachedDiagrams(document);

  // Re-render uncached blocks for the new theme.
  await renderMermaidBlocks(document);
};

/**
 * Attach a one-time MutationObserver that watches the global `data-theme`
 * attribute and re-renders all diagrams when it flips between light/dark.
 *
 * Returns a cleanup function. Safe to call multiple times — only the first
 * call attaches the observer.
 */
let themeObserverAttached = false;

export const watchThemeForMermaid = (): (() => void) => {
  if (themeObserverAttached) return () => undefined;
  themeObserverAttached = true;

  const observer = new MutationObserver(() => {
    void refreshAllMermaidOnThemeChange();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  return () => {
    observer.disconnect();
    themeObserverAttached = false;
  };
};

// ---------------------------------------------------------------------------
// Image viewer (lightbox) — click a diagram to inspect it full-size
// ---------------------------------------------------------------------------

/** CSS class for the image viewer overlay (singleton enforced). */
const IMAGE_VIEWER_CLASS = "mermaid-image-viewer";

/**
 * Open a full-screen lightbox for a mermaid block's rendered SVG.
 *
 * The SVG is cloned so the viewer stays stable even if the underlying block is
 * re-rendered or evicted. Supports wheel zoom (cursor-anchored), drag pan,
 * double-click reset-to-fit, toolbar zoom controls, Esc / backdrop close.
 *
 * The diagram view (`.mermaid-view-diagram svg`) receives `cursor: zoom-in`
 * via CSS to hint that it is clickable.
 *
 * Only one viewer is allowed at a time — opening while one exists replaces it.
 */
export const openMermaidImageViewer = (block: HTMLElement): void => {
  const svg = getBlockSvg(block);
  if (!svg) return;

  // Singleton: remove any existing viewer first.
  document
    .querySelectorAll(`.${IMAGE_VIEWER_CLASS}`)
    .forEach((el) => el.remove());

  const overlay = document.createElement("div");
  overlay.className = IMAGE_VIEWER_CLASS;
  if (!isDarkTheme()) {
    overlay.classList.add("is-light");
  }
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Diagram preview");

  // Clone the SVG and make it self-contained so it renders at its natural
  // vector size inside the viewer (independent of the live block's CSS).
  const clone = svg.cloneNode(true) as SVGSVGElement;
  if (!clone.getAttribute("xmlns")) {
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  const viewBox = svg.viewBox.baseVal;
  const naturalW =
    viewBox && viewBox.width > 0 ? viewBox.width : svg.clientWidth;
  const naturalH =
    viewBox && viewBox.height > 0 ? viewBox.height : svg.clientHeight;
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
    clone.setAttribute("width", String(viewBox.width));
    clone.setAttribute("height", String(viewBox.height));
  }
  clone.removeAttribute("style");

  const stage = document.createElement("div");
  stage.className = "mermaid-image-viewer-stage";
  stage.appendChild(clone);

  const toolbar = document.createElement("div");
  toolbar.className = "mermaid-image-viewer-toolbar";

  // --- Zoom state ---------------------------------------------------------
  let scale = 1;
  let x = 0;
  let y = 0;
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 8;

  const apply = (): void => {
    clone.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };

  const fit = (): void => {
    const vw = stage.clientWidth;
    const vh = stage.clientHeight;
    const s = Math.min(vw / (naturalW || 1), vh / (naturalH || 1), 1);
    scale = Math.max(MIN_SCALE, Math.min(s, MAX_SCALE));
    x = 0;
    y = 0;
    apply();
  };

  const zoomBy = (factor: number, originX?: number, originY?: number): void => {
    const prev = scale;
    scale = Math.max(MIN_SCALE, Math.min(scale * factor, MAX_SCALE));
    if (originX !== undefined && originY !== undefined) {
      // Keep the point under the cursor stationary. transform-origin is the
      // element center, so a point at (originX, originY) relative to that
      // center shifts by origin*(prev - scale) under a scale change — adjust
      // the translate offset to compensate.
      x = x + originX * (prev - scale);
      y = y + originY * (prev - scale);
    }
    apply();
  };

  // --- Cleanup ------------------------------------------------------------
  const close = (): void => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };

  // --- Toolbar buttons (lucide icon paths) --------------------------------
  const makeBtn = (title: string, innerSvg: string): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mermaid-image-viewer-btn";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${innerSvg}</svg>`;
    return btn;
  };

  const zoomInBtn = makeBtn(
    "Zoom in",
    '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>',
  );
  const zoomOutBtn = makeBtn(
    "Zoom out",
    '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="8" x2="14" y1="11" y2="11"/>',
  );
  const resetBtn = makeBtn(
    "Reset",
    '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  );
  const closeBtn = makeBtn(
    "Close",
    '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  );

  zoomInBtn.addEventListener("click", () => zoomBy(1.25));
  zoomOutBtn.addEventListener("click", () => zoomBy(1 / 1.25));
  resetBtn.addEventListener("click", fit);
  closeBtn.addEventListener("click", close);

  toolbar.append(zoomInBtn, zoomOutBtn, resetBtn, closeBtn);
  overlay.append(stage, toolbar);
  document.body.appendChild(overlay);

  // Fit once laid out.
  requestAnimationFrame(fit);

  // --- Wheel zoom (cursor-anchored) --------------------------------------
  stage.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      // Cursor position relative to the stage center (= transform origin).
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomBy(factor, cx, cy);
    },
    { passive: false },
  );

  // --- Drag pan -----------------------------------------------------------
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startTx = 0;
  let startTy = 0;

  stage.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startTx = x;
    startTy = y;
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      // capture may fail if the pointer is already released — ignore.
    }
    stage.classList.add("is-grabbing");
  });

  stage.addEventListener("pointermove", (e: PointerEvent) => {
    if (!dragging) return;
    x = startTx + (e.clientX - startX);
    y = startTy + (e.clientY - startY);
    apply();
  });

  const endDrag = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    try {
      stage.releasePointerCapture(e.pointerId);
    } catch {
      // already released — ignore.
    }
    stage.classList.remove("is-grabbing");
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  // Double-click resets to fit.
  stage.addEventListener("dblclick", fit);

  // Close when clicking the backdrop (not the SVG/toolbar).
  overlay.addEventListener("click", (e: MouseEvent) => {
    if (e.target === overlay) close();
  });

  document.addEventListener("keydown", onKey, true);
};
