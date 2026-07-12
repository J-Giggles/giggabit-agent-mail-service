# Release checklist

## Candidate

- [ ] `CHANGELOG.md` and migration notes are current.
- [ ] Gateway and plugin metadata agree on the intended semantic version.
- [ ] `./scripts/verify.sh` passes.
- [ ] `./scripts/verify-public-release.sh` passes.
- [ ] `./scripts/verify-integration.sh` passes with zero skips and retries.
- [ ] Dependency vulnerability and licence checks pass.
- [ ] Gitleaks scans the candidate tree and the complete proposed public history.
- [ ] `VERSION="$(jq -r '.version' gateway/package.json)"; ./scripts/verify-release-history.sh "v${VERSION}"` proves clean ancestry
      from the exact sanitized public root and an exact version tag.
- [ ] Fresh synthetic quickstarts pass from disposable clones.
- [ ] No live mailbox, provider registration, or installed service was used.

## Independent verification

- [ ] A different verifier checks the exact candidate SHA in a fresh worktree.
- [ ] Red and green Test Contract evidence is complete.
- [ ] The verifier changes no product files.
- [ ] Repository variable `VERIFIED_SHA` equals the accepted exact candidate.

## GitHub publication

- [ ] Public history descends from exactly one sanitized root commit.
- [ ] Default branch is `main` and branch protection is enabled.
- [ ] Issues and GitHub Private Vulnerability Reporting are enabled.
- [ ] CI and CodeQL pass on the exact public commit.
- [ ] The tag is exactly `v` followed by the version in `gateway/package.json`
      and points to that commit.
- [ ] An unauthenticated fresh clone completes the documented quickstart.

Publication stops on any failed, skipped, retried, stale, or secret-bearing
evidence.
