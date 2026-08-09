# Branch Protection Setup (Manual, One-Time, Admin-Only)

This repository's CI (`.github/workflows/ci.yml`) runs `npm run lint`, `npm test`,
and `npm audit` on every push and pull request targeting `master`. Running CI is
not the same as **enforcing** it — by default, GitHub allows a pull request to
be merged even if its CI checks are failing. To require CI to pass before a PR
can be merged, GitHub's branch protection "required status checks" feature must
be turned on.

**This cannot be done via the GitHub API without authenticated, admin-level
credentials**, which this project's automated tooling does not have. It must be
performed manually, once, by a repository owner or admin.

## Prerequisite

Do this only **after** confirming the `test` job in `ci.yml` is passing on
`master` (i.e., after the lint-step fix in this same change lands and CI is
green). Turning on required status checks before the job is reliably green
will block all merges, including legitimate ones.

## Exact steps

1. Go to the repository on GitHub: `https://github.com/iamabhishek-n/vectra-js`.
2. Click **Settings** (top navigation bar of the repo).
3. In the left sidebar, click **Branches**.
4. Under "Branch protection rules", click **Add branch protection rule** (or
   **Add rule**, depending on GitHub's current UI wording).
5. In the **Branch name pattern** field, enter: `master`
6. Check the box **Require status checks to pass before merging**.
7. In the search box that appears under that option, find and select the
   `test` job (the job defined in `.github/workflows/ci.yml`). It may be
   listed as `test` or `CI / test` depending on how GitHub has indexed recent
   workflow runs — if it does not appear yet, push at least one commit or PR
   through CI first so GitHub has a run to index, then return to this screen.
8. Check the box **Require branches to be up to date before merging** (this
   is a sub-option of the status-checks setting; make sure it's enabled so
   stale branches must be rebased/merged with `master` before merging).
9. Scroll down and click **Create** (or **Save changes**).

Once saved, pull requests targeting `master` will be blocked from merging
until the `test` job (lint + tests + audit) succeeds and the branch is up to
date with `master`.

## Who can do this

Only a user with **admin** (owner) permissions on the repository can access
`Settings → Branches` and create or edit branch protection rules. This step
is intentionally excluded from any automated tooling or CI workflow in this
repository, since GitHub does not permit it to be configured via an
unauthenticated or non-admin API call.
