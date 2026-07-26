# Deploy

Copies of the systemd units that run AURA on the host. These are the source of
truth for reproducing the setup; the live files are under `/etc/systemd/system/`.

## Files

- `aura.service` — the daemon unit. Runs `packages/daemon/dist/cli.js` from the
  repo root on `127.0.0.1:8311`.
- `aura.service.d/vault.conf` — drop-in that points `AURA_VAULT` at a contained
  folder inside the Obsidian vault (`/opt/agentic/obsidian/vault`, synced by
  Syncthing). AURA writes daily briefs and reads/indexes notes only within that
  subfolder.

## Install / update

```sh
npm run build --workspace @aura/daemon --workspace @aura/shell
cp deploy/aura.service /etc/systemd/system/aura.service
mkdir -p /etc/systemd/system/aura.service.d
cp deploy/aura.service.d/vault.conf /etc/systemd/system/aura.service.d/vault.conf
systemctl daemon-reload
systemctl enable --now aura.service
```

## Notes

- Without `AURA_VAULT`, the daemon falls back to `<cwd>/vault` and silently
  creates a stray vault — always run it via systemd, not by hand from an
  arbitrary directory.
- The vault subtree is owned `debian:debian` to match the Syncthing container
  (PUID/PGID 1000). Keep new directories under the vault chowned to `debian` so
  sync can manage files the root-run daemon writes there.
