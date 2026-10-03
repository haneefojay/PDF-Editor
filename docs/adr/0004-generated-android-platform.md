# ADR 0004: generated Capacitor Android platform

- Status: accepted
- Date: 2026-10-03

## Decision

Treat `capacitor.config.ts`, web source, dependencies, and `scripts/prepare-android.mjs` as the canonical Android source. Generate `android/` deterministically during local and CI builds instead of versioning generated Gradle output, binary wrapper assets, copied web bundles, and launcher rasterizations.

Use Capacitor Filesystem cache storage followed by the Android share sheet for exports. Use the system file input for imports. Do not request broad external-storage permissions. Disable Android backup and cleartext traffic, and keep all runtime assets offline.

## Consequences

- `pnpm android:prepare` recreates the complete native project.
- CI can build an installable debug APK without checked-in generated binaries.
- Production signing keys remain outside source control and must be injected as protected CI secrets.
- Native changes must be encoded in the preparation script or Capacitor configuration, not edited only inside generated `android/` files.
