# Preparing a GitHub repository

Use this clean source folder as the repository root. It includes the CLI, modules, tests, examples and documentation. Archives, credentials, real account paths, transcripts and browser profiles are excluded.

Run `npm install`, `npm test` and `npm run check` before publishing. Keep `package-lock.json` so fresh installs and CI resolve the same dependency. GitHub Actions runs offline tests on Node.js 22 and 24.

Review staged files with `git status --short` and `git diff --cached`. `.gitignore` excludes local `.env` files, settings, archive indexes, media directories, error logs, journals and browser data. An unusual custom archive layout may need more exclusions. Upload source files, not your populated working directory.

`private: true` prevents accidental npm publication. It does not prevent a public GitHub repository. No personal author, repository URL or open-source license is assumed. Choose a license and add `LICENSE` if you want to permit reuse, then update package metadata.

This package does not create or publish a GitHub repository. Browser scanning remains subject to Discord policy, and behavior can change with the interface. Describe the supported media/link scope and verification limits in release notes.
