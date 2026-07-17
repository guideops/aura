import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * App-to-app pairing (smart-TV style): AURA mints a short-lived numeric code,
 * the peer's backend redeems it once for a long-lived bearer token. Tokens are
 * stored hashed — a stolen peers file reveals nothing usable.
 */

export interface Peer {
  id: string;
  name: string;
  tokenHash: string; // sha256 hex of the bearer token
  pairedAt: number;
  lastSeenAt: number;
  vaultPath?: string; // peer-reported, powers "adopt vault" UX
}

/** Wire-safe peer view (no token hash). */
export interface PeerInfo {
  id: string;
  name: string;
  pairedAt: number;
  lastSeenAt: number;
  vaultPath?: string;
}

const CODE_TTL_MS = 90_000;

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export class PairingManager {
  private peers = new Map<string, Peer>();
  private pending: { code: string; expiresAt: number } | null = null;

  constructor(private file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Peer[];
      for (const p of raw) this.peers.set(p.id, p);
    } catch {
      // first run / unreadable — start empty
    }
  }

  /** Mint (or replace) the single pending pairing code. */
  startPairing(): { code: string; expiresAt: number } {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    this.pending = { code, expiresAt: Date.now() + CODE_TTL_MS };
    return this.pending;
  }

  get pendingCode(): { code: string; expiresAt: number } | null {
    if (this.pending && this.pending.expiresAt < Date.now()) this.pending = null;
    return this.pending;
  }

  /** Redeem a code exactly once → bearer token for the new peer. */
  claim(code: string, name: string): { token: string; peer: PeerInfo } | null {
    const pending = this.pendingCode;
    if (!pending || pending.code !== code) return null;
    this.pending = null; // single use
    const token = crypto.randomBytes(32).toString("hex");
    const peer: Peer = {
      id: crypto.randomUUID(),
      name: name || "peer",
      tokenHash: sha256(token),
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.peers.set(peer.id, peer);
    this.save();
    return { token, peer: this.toInfo(peer) };
  }

  /** Bearer token → peer, touching lastSeenAt. Null when unknown/revoked. */
  verify(token: string | undefined): Peer | null {
    if (!token) return null;
    const hash = sha256(token);
    for (const peer of this.peers.values()) {
      if (peer.tokenHash === hash) {
        peer.lastSeenAt = Date.now();
        return peer;
      }
    }
    return null;
  }

  heartbeat(peerId: string, info: { name?: string; vaultPath?: string }): PeerInfo | null {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    if (info.name) peer.name = info.name;
    if (info.vaultPath !== undefined) peer.vaultPath = info.vaultPath;
    peer.lastSeenAt = Date.now();
    this.save();
    return this.toInfo(peer);
  }

  revoke(peerId: string): boolean {
    const had = this.peers.delete(peerId);
    if (had) this.save();
    return had;
  }

  list(): PeerInfo[] {
    return [...this.peers.values()].map((p) => this.toInfo(p));
  }

  private toInfo(p: Peer): PeerInfo {
    const info: PeerInfo = { id: p.id, name: p.name, pairedAt: p.pairedAt, lastSeenAt: p.lastSeenAt };
    if (p.vaultPath !== undefined) info.vaultPath = p.vaultPath;
    return info;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify([...this.peers.values()], null, 2));
  }
}
