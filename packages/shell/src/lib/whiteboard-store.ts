import { useSyncExternalStore } from "react";

/**
 * Shared whiteboard state between the center Whiteboard tab and the right-rail
 * AI assistant: which board is open, what's selected, and a refresh tick that
 * bumps when the daemon reports external/agent edits (WS canvas.updated).
 */
export interface WbState {
  canvasId: string | null;
  canvasName: string;
  selection: string[];
  /** Bumped when the open board changed server-side; viewers refetch. */
  refreshTick: number;
  /** Bumped when the board list changed (created/removed). */
  listTick: number;
}

let state: WbState = { canvasId: null, canvasName: "", selection: [], refreshTick: 0, listTick: 0 };
const listeners = new Set<() => void>();

function emit(next: Partial<WbState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function wbOpen(canvasId: string | null, canvasName = "") {
  emit({ canvasId, canvasName, selection: [] });
}
export function wbSelect(selection: string[]) {
  emit({ selection });
}
export function wbRefresh() {
  emit({ refreshTick: state.refreshTick + 1 });
}

/** Called by the WS store for canvas.* messages. */
export function onCanvasMessage(msg: { kind: string; canvasId?: string; origin?: string }) {
  // "ui" edits originate from this surface — refetching would fight in-flight
  // local interactions. External (Obsidian) and agent edits must refetch.
  if (msg.kind === "canvas.updated" && msg.canvasId === state.canvasId && msg.origin !== "ui") {
    emit({ refreshTick: state.refreshTick + 1 });
  }
  if (msg.kind === "canvas.created" || msg.kind === "canvas.removed") {
    emit({ listTick: state.listTick + 1 });
    if (msg.kind === "canvas.removed" && msg.canvasId === state.canvasId) {
      emit({ canvasId: null, canvasName: "", selection: [] });
    }
  }
}

export function useWb<T>(selector: (s: WbState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state),
  );
}
