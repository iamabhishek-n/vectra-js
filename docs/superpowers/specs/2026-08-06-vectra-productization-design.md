# Vectra Productization & Security Design

**Date:** 2026-08-06
**Status:** Approved (design), pending implementation plan
**Scope:** Three sibling repos under `C:\Users\shiny\OneDrive\Desktop\Github\vectra\`:
- `vectra-js` — Node.js RAG SDK (this repo)
- `vectra-py` — Python RAG SDK
- `vectra-site` — marketing/docs site (React + Vite SPA)

A fourth sibling, `vectra-doc` (a near-abandoned Mintlify docs project), is in scope only as a decision point in Phase 4 (merge into vectra-site's docs or retire it) — it is not a peer repo carrying its own workstream.

## Goal

Make vectra (JS SDK + Python SDK + site) into a best-in-class **open-source** RAG SDK project. Success is measured by adoption, trust, and community health — not revenue. No hosted/paid tier is in scope for this plan; if that direction is pursued later it gets its own spec.

## Background

A prior audit (this session, not repeated here) found:
- vectra-js and vectra-py are near-mirror RAG orchestration SDKs (not local vector indexes — they wrap Postgres/pgvector, Prisma, ChromaDB, Qdrant, Milvus + OpenAI/Gemini/Anthropic/OpenRouter/HuggingFace/Ollama), both with zero automated tests, mocked/stubbed reranking, unenforced guardrails schemas, and inconsistent hybrid-search coverage across backends.
- vectra-js is GPL-3.0; vectra-py's license metadata self-contradicts (MIT declared in `pyproject.toml`, GPLv3 in its classifier, and a GPLv3-length `LICENSE` file on disk).
- vectra-site's Python install instructions read `pip install vectra-py` — the wrong PyPI package (an unrelated pre-existing library). The correct, confirmed-live package name is **`vectra-rag-py`**.
- vectra-site has no pricing/blog/changelog, fabricated "live" homepage stats (fake incrementing counters), three unreconciled domains across its SEO surfaces, dead Discord/Twitter links, and a stale roadmap.
- A parallel, effectively abandoned docs project (`vectra-doc`, Mintlify-based, 2 commits, last touched January) duplicates vectra-site's docs content with no cross-linking.

## Decisions locked in for this plan

1. **License target: MIT**, for both `vectra-js` and `vectra-py`. Every license surface (LICENSE file, `package.json`/`pyproject.toml` fields, classifiers, README badges) must agree — no repeat of vectra-py's current self-contradiction.
2. **Correct Python package name: `vectra-rag-py`** (confirmed by the user as the real, live PyPI package). Every reference to `vectra-py` as an install target anywhere in vectra-site, vectra-doc, or either SDK's own docs is a bug to fix.
3. **No monetization track.** This plan does not include pricing pages, hosted-product infrastructure, or paid tiers.
4. **Execution model:** work is dispatched primarily through the Agent tool, one agent per repo per workstream, isolated on feature branches (worktrees where an agent mutates files). No direct-to-master commits, no force-push. The user/orchestrating session reviews and merges between phases.

## Phase plan

Phases run **repo-parallel**: each phase is dispatched as concurrent per-repo agents rather than finishing one repo end-to-end before starting the next. This keeps `vectra-js` and `vectra-py` from drifting further apart, which they've already done once (e.g. vectra-py's hybrid search silently degrades to plain similarity for the native Postgres store, where vectra-js's Postgres store does real RRF fusion).

### Phase 1 — Trust & Correctness (blocking; do first)

Goal: nothing in this phase is optional or deferred — these are either live bugs or foundational blockers for every later phase.

- **vectra-site:** fix every `pip install vectra-py` occurrence (hero, footer, `FeaturesPage`/`Features.tsx`, `PythonDocs.tsx`) to `pip install vectra-rag-py`. Also fix the Python-examples link that currently points at the `vectra-js` repo instead of `vectra-py`.
- **vectra-js + vectra-py:** relicense to MIT — replace LICENSE file text, update `package.json`/`pyproject.toml` license fields and classifiers, update README badges/footer claims.
- **vectra-js + vectra-py:** stand up a real automated test suite (currently a stub script in JS, nonexistent in PY). Minimum bar: unit tests for config validation (Zod/Pydantic schemas), RRF fusion math, MMR selection, the SQL-identifier allowlist functions, and at least one integration-style test per vector-store backend using a mock/fake client. This is foundational — Phases 2 and 3 both edit `core.js`/`core.py` and the backend files repeatedly, and nothing currently catches a regression.
- **vectra-js + vectra-py:** telemetry default changes from on to off, or (if kept on) gains an explicit, visible first-run disclosure naming the endpoint and how to opt out.
- **vectra-py:** fix `Milvus.delete_documents` (always returns 0 regardless of actual deleted count) and implement `update_documents` for the Postgres and Milvus stores (currently `NotImplementedError`).

**Done when:** site's install command is live-correct; both SDKs are MIT with no metadata contradiction; a baseline test suite runs in CI for both; telemetry is off-by-default or disclosed; the three vectra-py CRUD bugs above are fixed.

### Phase 2 — Security hardening

- **vectra-js + vectra-py:** review and harden the regex-based SQL identifier allowlist (`isSafeIdentifier`/`quoteIdentifier` in JS, equivalent in PY) used for table/column names in the Postgres and Prisma stores; add adversarial tests targeting it specifically.
- **vectra-js + vectra-py:** wire dependency vulnerability scanning into CI (`npm audit` / `pip-audit`), failing the build on new high/critical findings.
- **vectra-js + vectra-py:** enforce the guardrails schema for real — `blockPii`/`block_pii`, `maxQueryLength`/`max_query_length`, `contentFilter`/`content_filter` currently validate but do nothing at runtime in either language; wire them into the `queryRAG`/`query_rag` path.
- **vectra-js + vectra-py:** document exactly what the telemetry payload contains (confirm no query content or PII is included by default); add this to each repo's README/docs.
- **vectra-js + vectra-py:** add ingestion input limits (max file size, allowed file types) to bound resource exhaustion from untrusted uploads.
- **All three repos:** add a `SECURITY.md` with a responsible-disclosure contact/process.
- **vectra-site:** confirm no XSS surface in dynamically rendered content, verify/add sane CSP headers in the Cloudflare Pages / Netlify config, and remove the fabricated "live" stats (query counter, jittering latency, static recall number) — misrepresentation on a public site is a trust/security-adjacent issue, not purely cosmetic.

**Done when:** `SECURITY.md` exists in all three repos; dependency scanning runs in CI for both SDKs; guardrails actually block/filter at runtime; the SQL identifier path has adversarial test coverage; telemetry payload contents are documented; site has no fake stats and a reviewed CSP.

### Phase 3 — Feature completion (close JS/PY drift + competitor gaps)

- **vectra-js + vectra-py:** replace mocked rerankers with real Cohere, Jina, and/or local cross-encoder integrations.
- **vectra-js + vectra-py:** extend hybrid search (RRF or equivalent) to Qdrant, Milvus, and ChromaDB — currently only Postgres/Prisma get real lexical+semantic fusion (and in vectra-py, even native Postgres currently falls back to plain similarity search — this is also a Phase 3 fix, distinct from the Prisma path which does work).
- **vectra-js + vectra-py:** stop hardcoding the 1536-dimension assumption in Postgres/Prisma table creation; read the configured embedding dimension.
- **vectra-py only:** wire HuggingFace into the embedder factory (`_create_embedder`) — the README already documents it as an embedding provider but the code doesn't route to it.
- **vectra-js + vectra-py:** reconcile the two parallel evaluation implementations (`VectraClient.evaluate()` vs. the standalone/orphaned `evaluation` module in each language) down to one canonical implementation; delete the other.
- **vectra-js + vectra-py:** switch MMR diversity scoring from lexical Jaccard token overlap to embedding-space cosine distance.
- **vectra-js + vectra-py:** replace the character-count token estimator with a real tokenizer (e.g. `tiktoken` where applicable, or provider-native counts).
- **Stretch, both SDKs:** a minimal local/offline vector store backend (brute-force, file-based) — closes the gap against the project's own namesake and gives a zero-dependency prototyping/testing path. Only pursued if Phases 1-2 and the rest of Phase 3 land with room to spare.

**Done when:** rerankers are real in both SDKs; hybrid search works (with a real lexical component) across all five vector stores in both SDKs; embedding dimension is configurable end-to-end; evaluation is a single implementation per SDK; MMR is embedding-space based.

### Phase 4 — Site & docs consolidation

- Settle on one canonical domain; fix `robots.txt`, `sitemap.xml`, and the SEO component's default URL/OG values to agree; add the missing `/features` route to the sitemap; update the stale `lastmod` date.
- Remove or properly implement the Discord/Twitter footer links (real working links, or remove until a channel exists).
- Decide vectra-site vs. vectra-doc as the one canonical docs surface; migrate any content worth keeping from the losing project into the winner, then archive/retire the other (add a redirect or an explicit "moved" notice, don't just delete silently if it has any inbound links).
- Refresh the roadmap section so it doesn't show already-past quarters as "planned"/"in progress."

**Done when:** one domain is referenced everywhere; no fabricated content remains; no dead links; exactly one docs surface is canonical and the other is either merged in or clearly retired.

### Phase 5 — OSS governance

- Add `CONTRIBUTING.md` and issue/PR templates to all three repos (vectra-py already has a `CODE_OF_CONDUCT.md`; the other two don't).
- Add CI required-status-checks (lint + the new test suite from Phase 1) gating merges to master, for both SDK repos.
- Add `CHANGELOG.md` to both SDK repos and adopt semver discipline going forward (the current history shows same-day version bumps alongside unrelated feature commits, e.g. v1.0.0 and the HuggingFace backend landing together).
- Stand up one real community channel (GitHub Discussions is the lowest-friction option, avoids the "unset Discord link" problem entirely) before linking it anywhere.

**Done when:** all three repos have contribution docs and templates; both SDK repos gate merges on passing CI; both have a live changelog; the site links to a real, working community channel.

## Out of scope

- Any hosted/paid product, pricing page, or billing infrastructure.
- New vector-store or LLM-provider integrations beyond what's already partially wired (e.g. adding a brand-new provider not already in the enum).
- A rewrite of either SDK's core architecture (the layered client/backend design stays; this plan hardens and completes it, not replaces it).
- vectra-doc's content is only handled as a Phase 4 merge-or-retire decision, not audited feature-by-feature the way the three primary repos are.

## Execution mechanics

- Each phase fans out as one Agent-tool call per affected repo (isolated on a feature branch, worktree-isolated when the agent will mutate files), run in parallel within the phase.
- The orchestrating session reviews the diff from each agent and merges to that repo's master before the phase is considered closed for that repo.
- No phase N+1 work starts for a given repo until that repo's phase N changes are merged. Once Phase 1 lands a test suite, "merged" additionally requires CI passing; before that, review is manual.
- No direct-to-master commits, no force-push, no skipped hooks, consistent with standing git safety rules for this session.
