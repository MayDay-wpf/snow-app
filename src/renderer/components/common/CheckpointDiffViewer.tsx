import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { DiffViewer } from "../rightPanel/DiffViewer";

/** 回滚链来源：明细由 Rust 检查点服务按页计算，不在列表阶段生成。
 *  path 为检查点链上的文件路径（摘要 / 变更列表返回的路径）。 */
export type CheckpointDiffSource = {
  checkpointIds: string[];
  workDir: string;
  path: string;
};

/** 单页展示行数与字节上限：大文件按页追加，避免一次性传输整份 diff。 */
const PAGE_ROWS = 1000;
const PAGE_BYTES = 512 * 1024;

type LoadedDiff = {
  content: string;
  isBinary: boolean;
  tooLarge: boolean;
  shownRows: number;
  totalRows: number;
  revision: string;
};

type CheckpointDiffViewerProps = {
  source: CheckpointDiffSource;
  /** 标题栏展示的路径。 */
  displayPath: string;
  changeType: string;
};

/**
 * 检查点 diff 明细：首屏只取一页，滚动到末尾时自动追加下一页。
 * 两次翻页之间文件被修改（内容版本变化）时丢弃已加载内容并从头读取。
 */
export function CheckpointDiffViewer({
  source,
  displayPath,
  changeType,
}: CheckpointDiffViewerProps): React.JSX.Element {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<LoadedDiff | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef<LoadedDiff | null>(null);
  const loadingRef = useRef(false);
  /** 请求代际：来源变化或卸载后，在途请求的结果直接丢弃。 */
  const generationRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const sourceKey = useMemo(
    () => JSON.stringify([source.checkpointIds, source.workDir, source.path]),
    [source.checkpointIds, source.workDir, source.path],
  );

  const loadNextPage = useCallback(async (): Promise<void> => {
    if (loadingRef.current) {
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    setError("");
    const generation = generationRef.current;
    const current = sourceRef.current;
    const readPage = (startRow: number) =>
      window.snow.readCheckpointDiffPage(
        current.checkpointIds,
        current.workDir,
        current.path,
        startRow,
        PAGE_ROWS,
        PAGE_BYTES,
      );
    try {
      let previous = loadedRef.current;
      let page = await readPage(previous?.shownRows ?? 0);
      if (previous && page.revision !== previous.revision) {
        previous = null;
        page = await readPage(0);
      }
      if (generation !== generationRef.current) {
        return;
      }
      const next: LoadedDiff = {
        content: (previous?.content ?? "") + page.content,
        isBinary: page.isBinary,
        tooLarge: page.tooLarge,
        shownRows: page.nextRow,
        totalRows: page.totalRows,
        revision: page.revision,
      };
      loadedRef.current = next;
      setLoaded(next);
    } catch (loadError) {
      if (generation === generationRef.current) {
        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
      }
    } finally {
      if (generation === generationRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    loadedRef.current = null;
    loadingRef.current = false;
    setLoaded(null);
    void loadNextPage();
    return () => {
      generationRef.current += 1;
    };
  }, [sourceKey, loadNextPage]);

  const hasMore = loaded !== null && loaded.shownRows < loaded.totalRows;

  // 加载区进入可视范围即追加下一页；加载完成后重新观察，区域仍可见时继续追加。
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || loading || error) {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void loadNextPage();
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, error, loadNextPage]);

  const footer =
    loaded && (hasMore || error) ? (
      <div className="checkpoint-diff-more" ref={sentinelRef}>
        {error ? (
          <span className="checkpoint-diff-more-error" title={error}>
            {error}
          </span>
        ) : (
          <span>
            {t("chat.fileChanges.rowsProgress", {
              values: { shown: loaded.shownRows, total: loaded.totalRows },
            })}
          </span>
        )}
        <button
          type="button"
          className="checkpoint-diff-more-btn"
          disabled={loading}
          onClick={() => void loadNextPage()}
        >
          {loading
            ? t("chat.fileChanges.loadingMore")
            : t("chat.fileChanges.loadMore")}
        </button>
      </div>
    ) : null;

  return (
    <DiffViewer
      selectedFile={{
        path: displayPath,
        oldPath: null,
        indexStatus: "",
        workdirStatus: "",
        status: changeType,
      }}
      diffResult={
        loaded
          ? { content: loaded.content, isBinary: loaded.isBinary, error: "" }
          : error
            ? { content: "", isBinary: false, error }
            : null
      }
      diffLoading={loaded === null && !error}
      contentFooter={footer}
      emptyMessage={
        loaded?.tooLarge ? t("chat.fileChanges.tooLargeRemote") : undefined
      }
    />
  );
}
