# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Before 1.0.0 the public API may change in a minor release; breaking changes are called out explicitly.

## [Unreleased]

## [0.1.0] — 2026-08-04

First public release. The codebase predates it: it was extracted from a private repository where it had been
developed and run in production since 2026-07. History was not carried across, so this is commit one.

### Added

- Control plane: HTTP API, WebSocket worker gateway, background processor, PostgreSQL persistence with 44
  sequential migrations and row-level security.
- Worker protocol v1 with a documented envelope, job state machine and a journal-based recovery contract.
- Native authentication: Argon2id passwords, TOTP, recovery codes, sessions, and a fail-closed policy
  decision endpoint.
- Media pipeline: FFmpeg assembly, audio timeline, subtitle alignment, contact sheets, and mastering to a
  target loudness and sample rate.
- Story pipeline: structure planning, quality scorecard, repetition and continuity checks.
- Provider plugin contract, an empty-by-default registry, and a mock provider that renders real files so the
  whole pipeline runs without an account anywhere.
- `lint`, `typecheck`, `build` and `scan:secrets` entry points that need nothing installed.
- CI across Linux and Windows on Node 20 and 22, with every external action and container image pinned by
  commit SHA or image digest.

### Security

- Recovery codes are generated with `crypto.randomInt` instead of a modulo over a random byte, which had
  made the first eight characters of the alphabet about 12.5% more likely than the rest.
- The worker heartbeat period, which arrives from the server, is clamped to the gateway's own 5s–120s range.
  It previously had a lower bound only, and a value above 2^31-1 ms falls back to a 1 ms timer in Node.
- Values interpolated into an FFmpeg filtergraph are escaped through one shared helper that handles the
  backslash before the characters whose escapes introduce backslashes.
- The metadata block written into each story file is an HTML comment, and is now protected against `--!>`
  as well as `-->`.

### Changed from the private original

- FFmpeg is no longer a bundled dependency. It is located at runtime via `FFMPEG_PATH`, the optional static
  packages, or `PATH`. FFmpeg is GPL and this project does not redistribute it.
- Asset classification moved out of a provider-specific module into `lib/media/asset-policy.mjs`; the
  source-gate error code is now `E_ASSET_SOURCE_RESOLUTION_REJECTED`.
- The output-token cap is declared with `LLM_MAX_OUTPUT_TOKENS` instead of being inferred from a vendor name.
- Every path that pointed at the original maintainer's machine is now configuration: `AVC_STUDIO_HOME`,
  `PGBIN`, `FFMPEG_PATH`.

### Not included

- **No web dashboard.** The console this system is driven with privately is not published: provider account
  enrollment, proxy and tunnel management run through it. 0.1.0 ships the API that console talks to. A
  public UI is separate, planned work — see [ROADMAP.md](ROADMAP.md).
- No generation provider. The registry starts empty; the browser-automation providers used by the private
  deployment are not part of this project and will not be.
- The worker distributable builder, which packaged those providers.

[Unreleased]: https://github.com/avchub/avchub-studio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/avchub/avchub-studio/releases/tag/v0.1.0
