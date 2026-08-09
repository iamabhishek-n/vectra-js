# Contributing to Vectra

Thank you for your interest in contributing to Vectra! We welcome bug reports, feature requests, and pull requests from the community. This guide will help you get started.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Running Tests](#running-tests)
- [Linting](#linting)
- [Making a Pull Request](#making-a-pull-request)
- [Code of Conduct](#code-of-conduct)
- [Reporting Issues](#reporting-issues)

## Getting Started

### Prerequisites

- **Node.js** 18 or higher
- **npm**, **pnpm**, or your preferred Node.js package manager

### Setting Up Your Development Environment

1. **Clone the repository:**

```bash
git clone https://github.com/iamabhishek-n/vectra-js.git
cd vectra-js
```

2. **Install dependencies:**

```bash
npm install
# or
pnpm install
```

3. **Verify your setup:**

```bash
npm test
npm run lint
```

## Development Workflow

1. **Create a new branch** for your feature or fix:

```bash
git checkout -b fix/issue-name
# or
git checkout -b feature/feature-name
```

2. **Make your changes** following the code style of the project.

3. **Add or update tests** for any new functionality or bug fixes.

4. **Commit your changes** with clear, descriptive commit messages.

## Running Tests

We use **Jest** for testing. Run the test suite with:

```bash
npm test
```

All new features and bug fixes should include corresponding test cases. Tests are essential for maintaining code quality and preventing regressions.

## Linting

We use **ESLint** to maintain code consistency. Before submitting a pull request, ensure your code passes linting checks:

```bash
npm run lint
```

To automatically fix linting issues:

```bash
npm run lint:fix
```

## Making a Pull Request

1. **One logical change per PR** - Keep pull requests focused on a single feature, bug fix, or improvement.

2. **Update documentation** - If your change affects user-facing behavior, update the relevant documentation (README, examples, etc.).

3. **Reference related issues** - If your PR addresses an existing GitHub issue, include the issue number in your PR description (e.g., "Fixes #123").

4. **Ensure CI passes** - Your PR must pass all automated checks:
   - All tests must pass (`npm test`)
   - Linting must pass (`npm run lint`)

   (Maintainers: see [Branch Protection Setup](docs/BRANCH_PROTECTION_SETUP.md)
   for the one-time manual step that makes these checks required before merging.)

5. **Provide a clear PR description** - Explain what your change does, why it's needed, and how to test it.

6. **Be responsive to feedback** - We'll review your PR and may request changes or clarifications.

## Code of Conduct

Please review and adhere to our [Code of Conduct](CODE_OF_CONDUCT.md). We are committed to providing a welcoming and inclusive environment for all contributors.

## Reporting Issues

Found a bug or have a feature request? Please use the appropriate issue template:

- **Bug Report:** [Submit a bug report](.github/ISSUE_TEMPLATE/bug_report.md)
- **Feature Request:** [Submit a feature request](.github/ISSUE_TEMPLATE/feature_request.md)

When reporting issues, include:
- A clear description of the problem or request
- Steps to reproduce (for bugs)
- Expected vs. actual behavior
- Your environment (Node.js version, OS, package manager)
- Any relevant code snippets or error messages

## Versioning and Changelog Discipline

This project follows [Semantic Versioning](https://semver.org/). Version
bumps and `CHANGELOG.md` updates should happen in their own commit/PR,
separate from feature/fix commits.

This matters in practice: this repository's own history has several
same-day version bumps (e.g. `0.9.4` through `0.9.6`, and `0.9.10`/`0.9.11`)
landing as their own isolated commits alongside unrelated CI and feature
work committed the same day, and at least one version bump (`0.9.12`) was
folded into a feature commit rather than split out. That made it
significantly harder to reconstruct an accurate `CHANGELOG.md` after the
fact, since a version bump on its own commit gives no indication of what it
actually shipped. Keeping version bumps isolated, and pairing them with a
`CHANGELOG.md` entry in the same commit/PR, avoids repeating that problem.

---

Thank you for contributing to Vectra! We appreciate your help in making it better.
