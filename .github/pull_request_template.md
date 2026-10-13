## What and why

<!-- One or two sentences. Link the issue this was agreed in: "Closes #123". -->

## How it was tested

<!-- `npm test` result, plus anything checked by hand. -->

## Checklist

- [ ] There is an issue for this change, and it was agreed before work started (not needed for typos and small doc fixes).
- [ ] `npm test` passes locally.
- [ ] New behaviour has tests; the tests use `scripts/fake-claude.mjs`, never the real `claude`.
- [ ] No runtime dependencies were added (`package.json` has no `dependencies`).
- [ ] If `server/tiers.js` changed: a matching probe in `scripts/spike-claude.mjs` or a test exists, and the description says exactly what was verified, on which OS and Claude Code version, and what was not.
- [ ] README (including Known limits) and CHANGELOG are updated if behaviour changed.
- [ ] No secrets, personal paths or personal data in code, tests, fixtures or logs.
- [ ] I have read the contributor terms in CONTRIBUTING.md (LICENSE, Additional Terms §4) and agree to them for this contribution.
