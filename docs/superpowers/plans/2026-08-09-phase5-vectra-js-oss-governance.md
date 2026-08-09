# Phase 5 — vectra-js OSS Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give vectra-js the standard OSS contributor-facing scaffolding it's missing: CONTRIBUTING.md, a PR template, a lint step in CI, and a CHANGELOG.md with semver discipline going forward.

**Architecture:** Pure documentation/CI-config additions — no runtime code changes. `CODE_OF_CONDUCT.md` and `.github/ISSUE_TEMPLATE/` already exist (confirmed by direct inspection) and are NOT touched by this plan.

**Tech Stack:** GitHub Actions (`.github/workflows/ci.yml` already exists, runs `npm test` + `npm audit`), ESLint (already configured, `npm run lint` script exists but is never invoked in CI).

## Global Constraints

- Do not touch `.github/ISSUE_TEMPLATE/` (already exists) or `CODE_OF_CONDUCT.md` (already exists) — confirmed present, out of scope.
- Do not attempt to enable GitHub branch-protection / required-status-checks via any API — this requires authenticated, repo-admin-level GitHub access this session does not have (`gh auth login` was not run). Instead, Task 3 documents the exact manual steps for the repo owner to enable it themselves.
- CHANGELOG content (Task 4) must be reconstructed from real `git log` history — do not fabricate version numbers, dates, or feature descriptions not verifiable from actual commits/package.json version bumps.
- No direct-to-master commits, no force-push, no skipped hooks.

---

### Task 1: Add CONTRIBUTING.md

**Files:**
- Create: `CONTRIBUTING.md`

**Interfaces:**
- Produces: a `CONTRIBUTING.md` at the repo root covering: how to set up the dev environment, how to run tests (`npm install && npm test`), how to run lint (`npm run lint`), branch/PR naming conventions, and a link to `CODE_OF_CONDUCT.md`.

- [ ] **Step 1: Read for accuracy**

Read `package.json`'s `scripts` block (confirm exact test/lint commands: `npm test`, `npm run lint`, `npm run lint:fix`), and skim `README.md`'s existing "Contributing"-adjacent section if any exists, so `CONTRIBUTING.md` doesn't contradict it.

- [ ] **Step 2: Write CONTRIBUTING.md**

Create `CONTRIBUTING.md` with real, accurate sections:
- **Getting started**: `git clone`, `npm install`.
- **Running tests**: `npm test` (Jest), expectation that new features/fixes include tests.
- **Linting**: `npm run lint` / `npm run lint:fix` before submitting a PR.
- **Making a PR**: fork or branch, one logical change per PR, reference an issue if one exists, CI must pass (test + lint) before review.
- **Code of Conduct**: link to `CODE_OF_CONDUCT.md`.
- **Reporting bugs / requesting features**: link to the existing issue templates at `.github/ISSUE_TEMPLATE/`.

Keep it concise (this is a real open-source project's contributor doc, not a corporate handbook — a few hundred words is plenty).

- [ ] **Step 3: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs: add CONTRIBUTING.md"
```

---

### Task 2: Add a Pull Request template

**Files:**
- Create: `.github/PULL_REQUEST_TEMPLATE.md`

**Interfaces:**
- Produces: every new PR against this repo is pre-populated with a checklist (tests added/passing, lint clean, description of the change, linked issue if any).

- [ ] **Step 1: Read the existing issue templates for tone/format consistency**

Read `.github/ISSUE_TEMPLATE/bug_report.md` and `.github/ISSUE_TEMPLATE/feature_request.md` to match their existing Markdown style/tone.

- [ ] **Step 2: Write the PR template**

Create `.github/PULL_REQUEST_TEMPLATE.md` with:
- A short "What does this PR do?" prompt.
- A checklist: `- [ ] Tests added/updated and passing (\`npm test\`)`, `- [ ] Lint passes (\`npm run lint\`)`, `- [ ] Linked issue (if applicable)`.
- A "Related issue" line.

- [ ] **Step 3: Commit**

```bash
git add .github/PULL_REQUEST_TEMPLATE.md
git commit -m "docs: add pull request template"
```

---

### Task 3: Add a lint step to CI, document the manual branch-protection step

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `docs/BRANCH_PROTECTION_SETUP.md` (or append to CONTRIBUTING.md if a separate file feels like overkill — implementer's call, but it must be discoverable, so link it from CONTRIBUTING.md if created separately)

**Interfaces:**
- Produces: CI runs `npm run lint` on every push/PR to master, in addition to the existing `npm test`. A documented, exact, copy-pasteable set of manual steps for the repo owner to turn on GitHub's "required status checks" branch protection (this cannot be done via an API call without authenticated admin access, which this session does not have).

- [ ] **Step 1: Read the current CI workflow**

Read `.github/workflows/ci.yml` in full to see its exact current structure (job name, steps, Node version) before editing.

- [ ] **Step 2: Add the lint step**

Add a `run: npm run lint` step to the existing `test` job, after `npm install` and before (or after — implementer's call, before is more conventional so lint failures surface fast) the `npm test` step. Do not create a separate job unless there's a clear reason to (a single job keeps the existing structure simplest to reason about).

- [ ] **Step 3: Verify the lint step doesn't fail CI on pre-existing lint issues**

Run `npm run lint` locally first. If it currently fails (recall: a prior review in this session found "7 pre-existing prefer-const errors" in this repo), you have two choices — fix those 7 pre-existing lint errors as part of this task (preferred, since it's a small mechanical fix and makes the new CI gate actually meaningful from day one), or if fixing them is riskier/larger than expected, document them and use a non-blocking `continue-on-error: true` on the lint step as a temporary bridge, but note this explicitly in your report since it weakens the point of adding the gate. Prefer actually fixing the 7 errors — `eslint --fix` may resolve them automatically since `prefer-const` is auto-fixable.

- [ ] **Step 4: Write the branch-protection documentation**

Document the exact manual steps (this cannot be automated without authenticated admin API access): go to the repo's GitHub Settings → Branches → Add branch protection rule for `master` → check "Require status checks to pass before merging" → select the `test` job from `ci.yml` → check "Require branches to be up to date before merging" → Save. State plainly that this is a manual, one-time action only the repo owner/admin can perform (GitHub does not allow this via an unauthenticated or non-admin API call), and that it should be done once lint is passing in CI (Step 3).

- [ ] **Step 5: Run tests and lint locally, then run the full CI-equivalent sequence**

Run: `npm run lint && npm test`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml docs/BRANCH_PROTECTION_SETUP.md CONTRIBUTING.md
git commit -m "ci: add lint step to CI, document manual branch-protection setup"
```
(Adjust the file list if the branch-protection doc was folded into CONTRIBUTING.md instead of a separate file.)

---

### Task 4: Add CHANGELOG.md, adopt Keep-a-Changelog format going forward

**Files:**
- Create: `CHANGELOG.md`

**Interfaces:**
- Produces: a `CHANGELOG.md` following the [Keep a Changelog](https://keepachangelog.com/) format, with real historical entries reconstructed from `git log` and `package.json` version history, plus an `[Unreleased]` section at the top for future entries, plus a short note in `CONTRIBUTING.md` (added in Task 1) about the semver/changelog discipline expected going forward.

- [ ] **Step 1: Reconstruct real version history**

Run `git log --oneline --all -- package.json | head -30` and `git log -p --all -- package.json | grep -A2 '"version"'` (or a similar approach) to find every point `package.json`'s `version` field changed, and what commits landed around each bump. Cross-reference with `git tag` if any tags exist. Do NOT invent version numbers or dates not backed by real git history.

- [ ] **Step 2: Write CHANGELOG.md**

Structure:
```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.2] - <real date from git log>
### Fixed
- <real fix, from actual commit messages/PRs merged for this version>

## [1.0.1] - <real date>
...

## [1.0.0] - <real date>
### Added
- Initial production release.
```

Fill in real entries only for what you can verify from git history — if a version's exact changes are unclear from commit messages alone, use a brief, honest, generic entry (e.g. "Various fixes and internal improvements") rather than fabricating specifics. It's fine for early/small versions to have terse entries.

- [ ] **Step 3: Add a semver-discipline note to CONTRIBUTING.md**

Append a short section to `CONTRIBUTING.md` (created in Task 1): "This project follows [Semantic Versioning](https://semver.org/). Version bumps and CHANGELOG.md updates should happen in their own commit/PR, separate from feature/fix commits — check the git history's prior pattern of same-day version bumps landing alongside unrelated feature commits before this policy for context on why this matters."

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md CONTRIBUTING.md
git commit -m "docs: add CHANGELOG.md, document semver discipline"
```

---

## Self-Review Notes

- **Spec coverage:** CONTRIBUTING.md (Task 1), PR template (Task 2), CI lint gate + documented manual branch-protection step (Task 3), CHANGELOG.md + semver discipline (Task 4) — matches the design spec's Phase 5 bullets for the SDK repos, minus branch-protection itself (correctly identified as requiring manual/authenticated action this session cannot perform) and minus the community-channel item (handled once, cross-repo, not per-SDK-repo — see the design spec's framing of it as a single stand-up action, not per-repo work).
- **Placeholder scan:** no TBD/TODO; Task 4 explicitly instructs honest terse entries over fabrication where history is unclear, which is not a placeholder — it's a documented content-quality tradeoff.
- **No CODE_OF_CONDUCT/ISSUE_TEMPLATE work**: confirmed both already exist via direct file listing before writing this plan; explicitly called out in Global Constraints to prevent a task from redundantly recreating them.
