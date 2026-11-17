import { useEffect, useRef, useState } from "react";

/** 交叉淡入淡出时长（ms）。 */
const FADE_MS = 180;
/** 两次切换的最小间隔（ms）：工具跑得快时合并更新，避免标题行频繁变字。 */
const MIN_SWAP_INTERVAL_MS = 600;

type Layer = {
  id: number;
  text: string;
};

type FadingLabelProps = {
  text: string;
  className?: string;
};

/**
 * 单行文案的交叉淡入淡出：变化时旧文案一边淡出、新文案一边淡入，
 * 任意时刻都至少有一层可见，因此不会出现整行消失的闪烁。
 *
 * 高频变化（例如工具连续执行）按最小间隔合并，最多保留两层旧文案。
 */
export const FadingLabel = ({
  text,
  className,
}: FadingLabelProps): React.JSX.Element => {
  const [layers, setLayers] = useState<Layer[]>(() => [{ id: 0, text }]);
  const nextIdRef = useRef(1);
  const committedRef = useRef(text);
  const pendingRef = useRef(text);
  const lastSwapAtRef = useRef(0);
  const swapTimerRef = useRef<number | null>(null);
  const pruneTimersRef = useRef<number[]>([]);

  useEffect(() => {
    pendingRef.current = text;
    if (text === committedRef.current || swapTimerRef.current !== null) {
      return;
    }
    const wait = Math.max(
      0,
      MIN_SWAP_INTERVAL_MS - (Date.now() - lastSwapAtRef.current),
    );
    swapTimerRef.current = window.setTimeout(() => {
      swapTimerRef.current = null;
      const next = pendingRef.current;
      // 空文案不落地：任何时刻标题行都必须有内容可显示。
      if (!next || next === committedRef.current) {
        return;
      }
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      committedRef.current = next;
      lastSwapAtRef.current = Date.now();
      setLayers((prev) => [{ id, text: next }, prev[0]]);
      pruneTimersRef.current.push(
        window.setTimeout(() => {
          setLayers((prev) =>
            prev[0]?.id === id && prev.length > 1 ? prev.slice(0, 1) : prev,
          );
        }, FADE_MS),
      );
    }, wait);
  }, [text]);

  useEffect(() => {
    return () => {
      if (swapTimerRef.current !== null) {
        window.clearTimeout(swapTimerRef.current);
        swapTimerRef.current = null;
      }
      for (const timer of pruneTimersRef.current) {
        window.clearTimeout(timer);
      }
      pruneTimersRef.current = [];
    };
  }, []);

  const newestId = layers[0].id;
  // 只有一层时不动画：首次渲染不该先淡入一次。
  const animating = layers.length > 1;

  return (
    <span className={className} title={layers[0].text}>
      {layers.map((layer) => (
        <span
          key={layer.id}
          className={`fading-label-layer${
            layer.id !== newestId
              ? " is-leaving"
              : animating
                ? " is-entering"
                : ""
          }`}
        >
          {layer.text}
        </span>
      ))}
    </span>
  );
};
