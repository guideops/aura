import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export interface TreeNode {
  name: string;
  path: string; // relative, forward slashes
  type: "dir" | "file";
  gitStatus?: "M" | "U" | "A" | "D";
  children?: TreeNode[];
}

const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "dist-app", "dist-installer", ".turbo",
  "coverage", ".vite",
]);
const EXCLUDE_FILES = /\.(db|db-shm|db-wal|log)$|^aura\.peers\.json$/;
const MAX_DEPTH = 4;
const MAX_ENTRIES = 500;

/** Git working-tree status per file, keyed by repo-relative path (forward slashes). */
export function gitStatus(root: string): Promise<Map<string, "M" | "U" | "A" | "D">> {
  return new Promise((resolve) => {
    execFile("git", ["status", "--porcelain"], { cwd: root, timeout: 5000 }, (err, stdout) => {
      const map = new Map<string, "M" | "U" | "A" | "D">();
      if (err) return resolve(map);
      for (const line of stdout.split("\n")) {
        if (line.length < 4) continue;
        const x = line[0];
        const y = line[1];
        const file = line.slice(3).trim().replace(/^"|"$/g, "");
        if (x === "?" || y === "?") map.set(file, "U");
        else if (x === "A") map.set(file, "A");
        else if (x === "D" || y === "D") map.set(file, "D");
        else map.set(file, "M");
      }
      resolve(map);
    });
  });
}

export function gitBranch(root: string): Promise<{ branch: string; dirty: boolean } | null> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const branch = stdout.trim();
      execFile("git", ["status", "--porcelain"], { cwd: root, timeout: 5000 }, (err2, out2) => {
        resolve({ branch, dirty: !err2 && out2.trim().length > 0 });
      });
    });
  });
}

/** Workspace file tree with git badges; dirs first, bounded depth/size. */
export async function workspaceTree(root: string): Promise<TreeNode[]> {
  const status = await gitStatus(root);
  let count = 0;

  // A directory containing any changed file shows the strongest child badge.
  const dirBadge = (rel: string): "M" | "U" | undefined => {
    let saw: "M" | "U" | undefined;
    for (const key of status.keys()) {
      if (key.startsWith(rel + "/")) {
        const v = status.get(key);
        if (v === "M" || v === "A" || v === "D") return "M";
        saw = "U";
      }
    }
    return saw;
  };

  const walk = (dir: string, rel: string, depth: number): TreeNode[] => {
    if (depth > MAX_DEPTH || count > MAX_ENTRIES) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: TreeNode[] = [];
    const dirs = entries.filter((e) => e.isDirectory() && !EXCLUDE_DIRS.has(e.name) && !e.name.startsWith("."));
    const files = entries.filter((e) => e.isFile() && !EXCLUDE_FILES.test(e.name) && !e.name.startsWith("."));
    for (const d of dirs) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      count++;
      const children = walk(path.join(dir, d.name), childRel, depth + 1);
      const badge = dirBadge(childRel);
      const node: TreeNode = { name: d.name, path: childRel, type: "dir", children };
      if (badge) node.gitStatus = badge;
      nodes.push(node);
    }
    for (const f of files) {
      const childRel = rel ? `${rel}/${f.name}` : f.name;
      count++;
      const node: TreeNode = { name: f.name, path: childRel, type: "file" };
      const badge = status.get(childRel);
      if (badge) node.gitStatus = badge;
      nodes.push(node);
    }
    return nodes;
  };

  return walk(root, "", 0);
}
