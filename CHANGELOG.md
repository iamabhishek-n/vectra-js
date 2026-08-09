# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries below were reconstructed from `git log` and the version history in
`package.json`. Where a version's exact scope wasn't clear from commit
messages alone, the entry is intentionally brief and generic rather than
guessed.

## [Unreleased]

Work landed on top of the `1.0.2` release, not yet published to npm under a
new version number.

### Added
- Real hybrid search implementations for the Chroma, Qdrant, and Milvus vector
  stores (previously stubbed).
- Real Cohere and Jina reranker integrations via their REST APIs.
- Embedding-space MMR diversity selection, falling back to lexical Jaccard
  similarity when no embeddings are available.
- Real BPE tokenization via `js-tiktoken`, replacing a character-count
  heuristic.
- Configurable guardrails: max query length, PII blocking, content filtering,
  user-supplied blocked terms, and a configurable max file size limit for
  ingestion, all wired into `queryRAG`.
- `SECURITY.md`.
- Jest test runner and substantially expanded test coverage (guardrails,
  telemetry, vector store integration tests for Postgres/Prisma/Chroma/
  Qdrant/Milvus, reciprocal rank fusion, MMR, SQL identifier safety helpers).
- CI: run tests and `npm audit` on every push and pull request; added a lint
  step.
- `CONTRIBUTING.md`, pull request template, and documented manual
  branch-protection setup.

### Fixed
- Telemetry now defaults to off and is opt-in only.
- ReDoS-vulnerable pattern in the email PII check; explicit `0` limits are now
  treated as real limits instead of being ignored.
- Vector store embedding dimension now respects configuration instead of
  hardcoding `1536`.
- Jest hang caused by a telemetry flush timer left running in tests.
- `package.json` `license` field aligned with the MIT `LICENSE` file.
- Pre-existing `prefer-const` lint errors.
- Various order-preservation and Milvus scoring gaps found during review.

### Changed
- Project relicensed to MIT (LICENSE file added; see also the `1.0.2` entry
  below, which was the version bump that shipped this on npm).
- README corrected to reflect that telemetry is opt-in, not opt-out; guardrail
  and ingestion size-limit defaults documented.

## [1.0.2] - 2026-04-24
### Changed
- Relicensed the package to MIT (`package.json` `license` field updated
  alongside the `LICENSE` file added the same day).

## [1.0.1] - 2026-04-01
### Changed
- Version bump and package file updates; removed the standalone
  `RELEASE_NOTES.md` file.

## [1.0.0] - 2026-04-01
### Added
- First release tagged as a production version.

## [0.9.12] - 2026-03-04
### Added
- `fileExists` method for the Qdrant, Milvus, Prisma, and Postgres vector
  store backends, to check for existing documents by file metadata.
- `ON CONFLICT DO NOTHING` on Postgres/Prisma insert queries to avoid
  duplicate-ID errors.
- Fallback `ivfflat` index creation for Postgres when `HNSW` isn't supported.

### Fixed
- Schema detection/validation to prevent array-type vector column issues in
  Postgres.

## [0.9.11] - 2026-01-06
### Changed
- Version-only bump; no functional changes recorded in this commit.

## [0.9.10] - 2026-01-06
### Changed
- Version-only bump; no functional changes recorded in this commit.

## [0.9.8] - 2026-01-05
### Changed
- Dropped the `-beta` pre-release suffix ahead of further stabilization.

## [0.9.7] - 2026-01-02 (later re-tagged `0.9.7-beta`, `0.9.8-beta`)
### Added
- Native PostgreSQL vector store support.

### Changed
- Code quality and maintainability refactors across the codebase.

## [0.9.6] - 2025-12-31
### Changed
- npm publish CI workflow switched to OIDC authentication with provenance
  support, replacing token-based auth.

## [0.9.5] - 2025-12-31
### Changed
- npm publish CI workflow updated; manual publish script removed in favor of
  CI-driven publishing.

## [0.9.4] - 2025-12-31
### Added
- `publishConfig` in `package.json` to make the package publicly accessible
  on the npm registry.

## [0.9.3] - 2025-12-27
### Added
- SQLite-based observability with a dashboard UI.

## [0.9.1] - 2025-12-25
### Added
- Initial multi-provider RAG pipeline (embeddings, generation, and vector
  store backends).

### Changed
- Package metadata (repository, author, version) updated; `.npmignore`
  added.

---

Versions prior to `0.9.1` were pre-release scaffolding and are not tracked
individually here.
