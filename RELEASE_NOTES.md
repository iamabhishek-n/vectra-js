# Vectra-js 0.9.7-beta Release Notes

## New Features
*   **Native PostgreSQL Support**: Added `PostgresVectorStore` for direct PostgreSQL vector operations without Prisma dependency.
*   **Enhanced Validation**: Integrated Zod for robust configuration schema validation.
*   **Observability**: Added SQLite-based logging for better telemetry and debugging.

## Improvements
*   **Code Quality**: Refactored core logic to reduce magic numbers and improve maintainability (SonarCloud fixes).
*   **Linting**: Migrated to ESLint flat config and enforced stricter code style (no-var, prefer-const).
*   **CLI**: Improved stability and error handling in CLI commands.

## Fixes
*   Fixed potential unhandled promise rejections in observability logger.
*   Fixed console log noise in production builds.
