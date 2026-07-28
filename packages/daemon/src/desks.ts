import type { AgentStatus, SpaceFile } from "@aura/core";
import type { SpaceStore } from "./space-store.js";

/** Statuses that mean "at work". Everything else surrenders the desk. */
const WORKING: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  "active",
  "researching",
  "reading",
  "review",
  "blocked",
  "error",
]);

export function isWorking(status: AgentStatus): boolean {
  return WORKING.has(status);
}

/**
 * Desks are seats, not assignments: an agent claims a free one when it starts
 * working and gives it back the moment it stops, so the floor reads as live
 * occupancy. When every desk is taken the room grows a new one rather than
 * making an agent queue — the office should reflect the fleet, not cap it.
 */
export class DeskAllocator {
  /** agentId → deskId */
  private seats = new Map<string, string>();

  constructor(
    private space: SpaceStore,
    /** Called when a desk is added to the layout, so viewers can reload it. */
    private onLayoutChange: () => void = () => {},
  ) {}

  deskFor(agentId: string): string | null {
    return this.seats.get(agentId) ?? null;
  }

  /** Idempotent: an agent already seated keeps the desk it is sitting at. */
  claim(agentId: string): string {
    const seated = this.seats.get(agentId);
    if (seated) return seated;

    const space = this.space.load();
    const desks = space.primitives.filter((p) => p.kind === "desk").map((p) => p.id);
    const taken = new Set(this.seats.values());
    const free = desks.find((id) => !taken.has(id));
    const deskId = free ?? this.addDesk(space);
    this.seats.set(agentId, deskId);
    return deskId;
  }

  release(agentId: string): void {
    this.seats.delete(agentId);
  }

  /** Extends the layout with one more desk, laid out in a row to the right. */
  private addDesk(space: SpaceFile): string {
    const desks = space.primitives.filter((p) => p.kind === "desk");
    const n = desks.length + 1;
    const id = `desk-${String(n).padStart(2, "0")}`;
    space.primitives.push({
      id,
      kind: "desk",
      label: `Desk ${String(n).padStart(2, "0")} — Active Compute`,
      position: [2.9 * (n - 1), 0, n % 2 === 0 ? -1.3 : 0],
      rotationY: n % 2 === 0 ? -0.35 : 0,
      scale: [1, 1, 1],
      binding: { type: "none", target: "" },
    });
    this.space.save(space);
    this.onLayoutChange();
    return id;
  }
}
