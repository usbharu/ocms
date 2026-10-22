# Repository Guidelines

## Project Structure & Module Organization

`media-storage-spec-v2.md` is the design baseline. The encrypted storage and media/search implementation lives in `cmd/ocms`, `internal/{bff,catalog,transfer,cryptostore,search,media,contracts,platform}`, `web`, `runtime`, `infra`, `migrations`, and `scripts`. See `README.md` for exact commands and `docs/implementation-status.md` for acceptance coverage and unfinished work.

The planned stack is a TypeScript/React SPA, Go services (BFF, Catalog, Transfer, Search, and Media Worker), PostgreSQL, S3-compatible storage, and a separate embedding runtime. Preserve the service responsibilities defined in specification §3. Document the directory layout here when implementation begins.

## Build, Test, and Development Commands

Use `python3 scripts/dev-init.py`, `docker compose build`, and `docker compose up -d --wait` to start the local development stack. Validate it with `python3 scripts/integration.py`; `scripts/media-integration.py` validates AC-09–14 with real media/models, `scripts/job-recovery.py` validates leases and media retries, and `scripts/recovery.py` additionally stops dependencies and rotates test keys. Use `go test -race ./...` and `go vet ./...` for Go. Use `cd web` followed by `npm ci` and `npm run build` for the React SPA. Use `compose.verify.yaml` with `scripts/verify-init.py`, `scripts/verify-oidc.py`, `scripts/verify-otel-workload.py`, and `scripts/verify-otel.py` for real Hydra and OTLP evidence checks. Prerequisites and restricted-cache variants are documented in `README.md`.

- `git status --short`: inspect pending changes.
- `git diff --check`: check tracked changes for whitespace errors.
- `git diff -- media-storage-spec-v2.md`: review specification edits.

When adding executable modules, document their prerequisites and exact build, run, and test commands in the same change.

## Coding Style & Naming Conventions

Keep Markdown headings descriptive and maintain the specification's Japanese prose, numbered sections, tables, and fenced code blocks. Update related diagrams, DDL, and API examples together.

Use `gofmt`, idiomatic Go names, and `*_test.go` test files. TypeScript uses two-space indentation, single quotes, semicolons, PascalCase components and camelCase variables/functions. The frontend build runs strict TypeScript checks; no formatter is configured. Follow existing contract names such as `asset_id`, `blob_id`, and `/api/v1/assets`.

## Testing Guidelines

Go standard-library tests and Python standard-library Compose integration checks are configured; no coverage threshold has been established. Use specification §14 (AC-01–AC-18) to plan implementation validation. Prioritize unaligned Range reads, concurrent deduplication, ACL isolation, key rotation, job retries, and S3/DB failure recovery. Record test commands and results in pull requests; explicitly identify checks that could not run.

Verification environments must also support direct human use. The verification Compose stack exposes a guide at localhost:4446, manual OIDC login and the SPA at localhost:8081, and a provisioned Grafana dashboard at localhost:3000/d/ocms-verification. Automated checks supplement these workflows; they are not prerequisites for using the environment. Keep verification services running when handing the environment to the user, unless asked to stop them.

Worker and Transfer share `MEDIA_MAX_PDF_PAGES` (default 500); Worker uses `MEDIA_JOB_TIMEOUT_SECONDS` (default 7200). Apply migration 004 once on existing media databases before using inference checkpoints. Validate recovered PDFs with `scripts/verify-pdf-recovery.py <blob-id> ...`; keep document text and filenames out of test output. The current Colima environment uses 4 CPUs and 12 GiB after real inference exhausted the former 6 GiB allocation.

## Commit & Pull Request Guidelines

There is no commit history or established message convention. Use concise, imperative subjects, for example `docs: clarify upload retry behavior`. Keep changes focused. PR descriptions should explain the problem, affected specification sections or acceptance criteria, validation performed, and unresolved decisions. Link relevant issues and include screenshots for UI changes.

## Security & Configuration

Never commit real `secrets/crypto.yaml` keys, credentials, tokens, or private media. Use placeholders in examples. Keep key handling within Transfer and authorization within Catalog, as specified. Exclude key material, session tokens, and plaintext media from logs and traces.
