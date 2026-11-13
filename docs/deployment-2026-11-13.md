# Design update deployment — November 13, 2026

The separate Bills, Checks, Trips and Settings gear menu and readability changes are deployed to https://billhive.matts.media.

- Source: `c9eccca4e53aeb62d7ac44be116649e4a299d1bd`, pushed on `fix/shared-trip-creator-identity`.
- [Successful image build](https://github.com/MartyPortatoes/BillHive/actions/runs/43499377107).
- Production image: `ghcr.io/martyportatoes/billhive@sha256:2656ee0cf90a93820d74dd03f6280cbd2c2fa366ffc18ebd3b60908e07801a2c`.
- Portainer stack 379, endpoint 2, retained its ports, persistent data mount, revision preconditions, restart policy and Cloudflare Access labels. The running container reports the exact source revision and zero restarts.
- Before deployment, an online SQLite backup was created at `/data/release-backups/20261113-design/before.db`; its integrity check returned `ok`.
- Origin health passed. The served HTML and design stylesheet byte-match the committed files. The public endpoint continues to redirect unauthenticated requests to access authentication. No production financial records were edited for verification.
- Local validation before release: 259 Node tests passed and all eight design browser verification groups passed; see [design evidence](design-parity-2026-11-13.md).

Rollback image: `ghcr.io/martyportatoes/billhive@sha256:316f36c16ea2ee24944a2886fdba90a3dbf31ca94a01d8f8e6ea42a653c6bd5e` (previous source `fc4d88d`). Revert only the image first; restoring an old database would discard intervening writes. This update changes frontend code and verification tooling, with no server/schema changes.

Authenticated public browser interaction was not repeated during deployment. Responsive and keyboard interaction checks used synthetic local data before deployment.
