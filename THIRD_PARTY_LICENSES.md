# Third-party licenses

Dependencies are distributed under their respective licenses. Release builds must run the license audit workflow.

| Component | License | Purpose |
|---|---|---|
| MuPDF.js / MuPDF | AGPL-3.0 | PDF parsing and rendering |
| React | MIT | UI runtime |
| Vite | MIT | Build tooling |
| Zustand | MIT | Editor state |
| Immer | MIT | Immutable state updates |
| Zod | MIT | Runtime validation |
| Comlink | Apache-2.0 | Worker RPC |
| Lucide React | ISC | Icons |
| Dexie | Apache-2.0 | IndexedDB persistence |

Pin and audit the transitive dependency tree before every release.
