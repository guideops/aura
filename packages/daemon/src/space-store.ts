import fs from "node:fs";
import path from "node:path";
import { SpaceFile } from "@aura/core";

/**
 * Office layout persistence for Space CAD. One JSON file, zod-validated.
 * Default layout mirrors the hand-tuned scene office.html shipped with, so
 * first save produces no visual jump.
 */
export function defaultSpace(): SpaceFile {
  return SpaceFile.parse({
    version: 1,
    name: "AURA HQ",
    room: { width: 22, depth: 12, height: 3, gridSize: 0.5 },
    primitives: [
      { id: "desk-01", kind: "desk", label: "Desk 01 — Active Compute", position: [0, 0, 0], rotationY: 0 },
      { id: "desk-02", kind: "desk", label: "Desk 02 — Active Compute", position: [2.9, 0, -1.3], rotationY: -0.35 },
      { id: "vault-01", kind: "vault", label: "Vault — Secure Storage", position: [-4.2, 0, -3.2], rotationY: 0.5 },
      { id: "whiteboard-01", kind: "whiteboard", label: "Whiteboard — Ideas & Planning", position: [-4.9, 0, 1.6], rotationY: 0 },
      { id: "kanban-01", kind: "kanban-wall", label: "Kanban Wall — Work Items", position: [1.5, 0, -4.6], rotationY: 0 },
      { id: "gate-01", kind: "security-gate", label: "Security Gate — Access Control", position: [4.7, 0, 1.8], rotationY: 0 },
      { id: "skills-01", kind: "skills-library", label: "Skill Library", position: [4.5, 0, -3.5], rotationY: -0.7 },
      { id: "lounge-01", kind: "lounge", label: "Lounge — Idle", position: [-1.8, 0, 3.6], rotationY: 0 },
      { id: "design-01", kind: "design-board", label: "Design Board", position: [-2.4, 0, -4.6], rotationY: 0 },
      { id: "agenda-01", kind: "agenda-board", label: "Agenda Board — Strategy & Updates", position: [7.2, 0, -2.6], rotationY: 0.6 },
      { id: "council-01", kind: "council", label: "Council Chamber — Agent Council", position: [9.8, 0, 1.2], rotationY: -0.35 },
    ],
  });
}

export class SpaceStore {
  constructor(private file: string) {}

  load(): SpaceFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return SpaceFile.parse(raw);
    } catch {
      return defaultSpace();
    }
  }

  save(space: SpaceFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(space, null, 2));
  }
}
