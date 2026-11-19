import { createContext, useContext, useState, type ReactNode } from "react";

/** 与 chat-enter 入场动画时长一致。 */
export const ENTER_MS = 180;

/** 入场时钟：until 之前挂载的子孙视为与祖先同批入场。 */
export type EntranceClock = { until: number };

/** 子树永不播入场（由外层统一做过渡）。 */
export const SUPPRESSED_ENTRANCE: EntranceClock = { until: Infinity };

const EntranceContext = createContext<EntranceClock>({ until: 0 });

export const EntranceProvider = EntranceContext.Provider;

/** 读取当前作用域的入场时钟（原样透传给子树时使用）。 */
export const useEntranceClock = (): EntranceClock =>
  useContext(EntranceContext);

/**
 * 入场动画去重：祖先仍在播入场时挂载的节点不再自己播，
 * 避免消息 / 集合 / 卡片三层位移与透明度叠加。
 * 结果只在挂载时计算一次；clock 供子树继续判断。
 */
export const useEntrance = (): {
  suppressed: boolean;
  clock: EntranceClock;
} => {
  const parent = useContext(EntranceContext);
  const [state] = useState(() => {
    const now = performance.now();
    const suppressed = parent.until > now;
    return {
      suppressed,
      clock: { until: suppressed ? parent.until : now + ENTER_MS },
    };
  });
  return state;
};

/** 以本次挂载为入场起点的作用域；active=false（虚拟化回显）时不计入。 */
export const EntranceScope = ({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}): React.JSX.Element => {
  const parent = useContext(EntranceContext);
  const [clock] = useState<EntranceClock>(() => ({
    until: active
      ? Math.max(parent.until, performance.now() + ENTER_MS)
      : parent.until,
  }));
  return (
    <EntranceContext.Provider value={clock}>
      {children}
    </EntranceContext.Provider>
  );
};
