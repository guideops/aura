import { api } from "./api";
import type { CenterTab } from "../components/CenterArea";

/** Office object clicked inside the embedded office.html (aura:zone message). */
export interface ZoneContext {
  zone: string;
  label?: string;
}

interface ZoneActionCtx {
  onOpenTab: (t: CenterTab) => void;
}

export interface ZoneAction {
  label: string;
  sub: string;
  run: (ctx: ZoneActionCtx) => void;
}

export const ZONE_ACTIONS: Record<string, ZoneAction[]> = {
  kanban: [
    { label: "View Tasks", sub: "Browse work items in this wall", run: ({ onOpenTab }) => onOpenTab("kanban") },
    { label: "Open in Board", sub: "Open full board view", run: ({ onOpenTab }) => onOpenTab("kanban") },
    { label: "Sync Now", sub: "Sync cards and status", run: () => void api.githubSync() },
  ],
  board: [
    { label: "View Tasks", sub: "Browse work items in this wall", run: ({ onOpenTab }) => onOpenTab("kanban") },
    { label: "Sync Now", sub: "Sync cards and status", run: () => void api.githubSync() },
  ],
  vault: [
    { label: "Open Vault", sub: "Browse markdown memory", run: ({ onOpenTab }) => onOpenTab("office") },
  ],
  gate: [
    { label: "Review Approvals", sub: "Pending action requests", run: ({ onOpenTab }) => onOpenTab("office") },
  ],
  cad: [
    { label: "Edit Layout", sub: "Open Space CAD", run: ({ onOpenTab }) => onOpenTab("cad") },
  ],
};
