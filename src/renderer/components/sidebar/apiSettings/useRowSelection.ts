import { useEffect, useMemo, useState } from "react";

/** 表格多选状态：列表变化后自动剔除已不存在的选中项。 */
export function useRowSelection(allIds: string[]) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const idsKey = allIds.join("\n");

  useEffect(() => {
    const available = new Set(idsKey ? idsKey.split("\n") : []);
    setSelectedIds((previous) => {
      const next = previous.filter((id) => available.has(id));
      return next.length === previous.length ? previous : next;
    });
  }, [idsKey]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const isAllSelected =
    allIds.length > 0 && allIds.every((id) => selectedSet.has(id));
  const isPartiallySelected =
    !isAllSelected && allIds.some((id) => selectedSet.has(id));

  return {
    selectedIds,
    selectedSet,
    isAllSelected,
    isPartiallySelected,
    toggle: (id: string) =>
      setSelectedIds((previous) =>
        previous.includes(id)
          ? previous.filter((item) => item !== id)
          : [...previous, id],
      ),
    toggleAll: () => setSelectedIds(isAllSelected ? [] : [...allIds]),
    clear: () => setSelectedIds([]),
  };
}
