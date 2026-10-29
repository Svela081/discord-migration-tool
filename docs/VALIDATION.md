# Release validation

Validated on October 29, 2026, with Node.js 24.22.1.

- `npm ci --ignore-scripts`: clean dependency installation succeeded using the committed lockfile.
- `npm test`: **104 passed, 0 failed**. Includes the original 89 tests, four restored repair tests and 11 setup/session tests.
- JavaScript syntax checks passed for the entry point, source modules and tests.
- CLI checks covered repeated offline reports, root persistence, setup-error recovery, two single-channel tasks sharing one simulated browser, and browser closure on exit.
- Destination tests covered URL-based category resolution, creating a category from a server ID, duplicate-name disambiguation, saved mappings and the server/category ID mix-up.
- Environment tests verified automatic `.env` loading, shell-variable precedence and credential exclusion from saved settings.
- Git exclusion checks verified that source/examples remain eligible for Git while local credentials and representative archive paths are ignored.
- Release inspection found no prior user/server/channel identifiers, personal account paths or credentials in the packaged source.

The v1.20.3 reconciliation module and source capture module are byte-for-byte unchanged. The bot uploader's only edit exports an existing name-comparison helper. Archive changes restore the failed-path allowlist and separate retry report already used in v1.19.2.

No live Discord sign-in, category creation, reconciliation or upload was performed for this release. GitHub Actions is configured for Node.js 22 and 24; those hosted jobs have not run yet. No GitHub repository was created or published.
