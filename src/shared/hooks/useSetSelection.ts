import { useCallback, useMemo, useState } from 'react';

/// Selection-as-a-Set hook. Replaces the hand-written `toggleOne` / `toggleAll`
/// pairs that the system panels (CachesPanel, NodeModulesPanel, …) used to
/// duplicate. The `allKeys` argument is used by `toggleAll` to decide whether
/// a press should select every row or clear the set, mirroring how a header
/// checkbox behaves across every panel.
///
/// Callers pass the id/path of each row through `toggleOne`. Keep keys stable
/// across renders (strings or numbers) — the hook compares with `Set.has`,
/// not deep equality.

export type SetSelectionApi<T> = {
  selected: Set<T>;
  size: number;
  isSelected: (key: T) => boolean;
  toggleOne: (key: T) => void;
  toggleAll: (allKeys: T[]) => void;
  selectAll: (allKeys: T[]) => void;
  clear: () => void;
  setSelected: React.Dispatch<React.SetStateAction<Set<T>>>;
};

export function useSetSelection<T>(initial?: Iterable<T>): SetSelectionApi<T> {
  const [selected, setSelected] = useState<Set<T>>(() => new Set(initial ?? []));

  const toggleOne = useCallback((key: T) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleAll = useCallback((allKeys: T[]) => {
    setSelected((prev) =>
      prev.size === allKeys.length ? new Set() : new Set(allKeys),
    );
  }, []);

  const selectAll = useCallback((allKeys: T[]) => {
    setSelected(new Set(allKeys));
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
  }, []);

  const isSelected = useCallback((key: T) => selected.has(key), [selected]);

  return useMemo(
    () => ({
      selected,
      size: selected.size,
      isSelected,
      toggleOne,
      toggleAll,
      selectAll,
      clear,
      setSelected,
    }),
    [selected, isSelected, toggleOne, toggleAll, selectAll, clear],
  );
}
