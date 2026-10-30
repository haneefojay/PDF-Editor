# Third-party licenses

Dependencies are distributed under their own licenses. The table lists what ships in the app; `pnpm licenses list --prod` prints the full transitive tree, which should be reviewed before each release.

| Component | License | Purpose |
|---|---|---|
| MuPDF.js / MuPDF | AGPL-3.0 | PDF parsing, rendering, editing and HTML layout |
| Liberation fonts (Sans, Serif, Mono) | SIL Open Font License 1.1 | Fonts embedded in exported text ([license](packages/pdf-engine/src/fonts/LICENSE)) |
| React, React DOM | MIT | UI runtime |
| Zustand | MIT | Editor state |
| Immer | MIT | Immutable state updates |
| Zod | MIT | Runtime validation |
| Comlink | Apache-2.0 | Worker RPC |
| Dexie | Apache-2.0 | IndexedDB persistence |
| Lucide React | ISC | Icons |
| Tesseract.js, tesseract.js-core | Apache-2.0 | On-device OCR |
| @tesseract.js-data language packs | MIT (packaging); Apache-2.0 (Tesseract models) | OCR models for English, French, Spanish, German, Portuguese and Arabic |
| pdf-lib | MIT | Signature placeholders for digital signing |
| @signpdf (signpdf, signer-p12, placeholder-pdf-lib) | MIT | Certificate-backed digital signatures |
| node-forge (via @signpdf) | BSD-3-Clause or GPL-2.0 | PKCS#12 and signing cryptography |
| buffer | MIT | Node Buffer for the signing libraries |
| Anthropic TypeScript SDK | Apache-2.0 | Optional AI assistant (web only) |
| Capacitor (core, app, filesystem, share, status-bar, Android) | MIT | Android app shell and native file sharing |
| @capacitor-community/text-to-speech | MIT | Read aloud on Android |

Build and test tools (Vite, TypeScript, Turborepo, Vitest, Playwright, ESLint, axe-core) are not shipped in the app.
