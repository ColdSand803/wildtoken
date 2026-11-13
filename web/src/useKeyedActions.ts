import { useCallback, useState } from "react";

import { KeyedActions } from "./driver/keyedActions";

export function useKeyedActions<K>() {
  const [actions] = useState(() => new KeyedActions<K>());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<K>>(() => new Set());
  const run = useCallback(
    <T,>(id: K, operation: () => Promise<T>) =>
      actions.run(id, operation, () => setPendingIds(actions.snapshot())),
    [actions],
  );
  return { pendingIds, run };
}
