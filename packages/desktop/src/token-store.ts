import fs from "node:fs";
import path from "node:path";

/** Matches Electron's safeStorage surface so tests can substitute a fake. */
export interface Encryptor {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface GitHubLink {
  token: string;
  projectId: string;
}

/**
 * GitHub credentials at rest. The token is encrypted with the OS keychain
 * (Electron safeStorage: DPAPI on Windows, Keychain on macOS, libsecret on
 * Linux) before touching disk — the daemon still only ever holds it in memory.
 */
export class TokenStore {
  private file: string;

  constructor(dir: string, private crypto: Encryptor) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "github-link.json");
  }

  save(link: GitHubLink): void {
    if (!this.crypto.isEncryptionAvailable()) {
      throw new Error("OS encryption unavailable — refusing to store token in plaintext");
    }
    const payload = {
      projectId: link.projectId,
      token: this.crypto.encryptString(link.token).toString("base64"),
    };
    fs.writeFileSync(this.file, JSON.stringify(payload), "utf8");
  }

  /** Returns the decrypted link, or null when absent/undecryptable. */
  load(): GitHubLink | null {
    if (!fs.existsSync(this.file)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as {
        projectId?: string;
        token?: string;
      };
      if (!raw.projectId || !raw.token) return null;
      return {
        projectId: raw.projectId,
        token: this.crypto.decryptString(Buffer.from(raw.token, "base64")),
      };
    } catch {
      return null;
    }
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }

  get path(): string { return this.file; }
}
