import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenStore, type Encryptor } from "./token-store.js";

/** XOR "encryption" — enough to prove plaintext never hits disk. */
const fakeCrypto = (available = true): Encryptor => ({
  isEncryptionAvailable: () => available,
  encryptString: (t) => Buffer.from([...Buffer.from(t, "utf8")].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString("utf8"),
});

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-token-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("TokenStore", () => {
  it("round-trips a link", () => {
    const store = new TokenStore(dir, fakeCrypto());
    store.save({ token: "github_pat_secret", projectId: "PVT_1" });
    expect(store.load()).toEqual({ token: "github_pat_secret", projectId: "PVT_1" });
  });

  it("never writes the plaintext token to disk", () => {
    const store = new TokenStore(dir, fakeCrypto());
    store.save({ token: "github_pat_secret", projectId: "PVT_1" });
    const onDisk = fs.readFileSync(store.path, "utf8");
    expect(onDisk).not.toContain("github_pat_secret");
    expect(onDisk).toContain("PVT_1"); // project id is not a secret
  });

  it("refuses to save when OS encryption is unavailable", () => {
    const store = new TokenStore(dir, fakeCrypto(false));
    expect(() => store.save({ token: "t", projectId: "p" })).toThrow(/plaintext/);
    expect(fs.existsSync(store.path)).toBe(false);
  });

  it("returns null when nothing stored or file is corrupt", () => {
    const store = new TokenStore(dir, fakeCrypto());
    expect(store.load()).toBeNull();
    fs.writeFileSync(store.path, "not json");
    expect(store.load()).toBeNull();
  });

  it("clear removes the file", () => {
    const store = new TokenStore(dir, fakeCrypto());
    store.save({ token: "t", projectId: "p" });
    store.clear();
    expect(store.load()).toBeNull();
    store.clear(); // idempotent
  });
});
