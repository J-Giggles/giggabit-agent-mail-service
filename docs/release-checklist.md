# Release checklist

## Candidate

- [ ] `CHANGELOG.md` and migration notes are current.
- [ ] Version metadata agrees on `0.1.0`.
- [ ] `./scripts/verify.sh` passes.
- [ ] `./scripts/verify-public-release.sh` passes.
- [ ] `./scripts/verify-integration.sh` passes with zero skips and retries.
- [ ] Dependency vulnerability and licence checks pass.
- [ ] Gitleaks scans the candidate tree and complete proposed public history.
- [ ] `./scripts/verify-release-history.sh v0.1.0` proves a clean single-root
      history and exact version.
- [ ] Fresh synthetic quickstarts pass from disposable clones.
- [ ] No live mailbox, provider registration, or installed service was used.

## Independent verification

- [ ] A different verifier checks the exact candidate SHA in a fresh worktree.
- [ ] Red and green Test Contract evidence is complete.
- [ ] The verifier changes no product files.
- [ ] Repository variable `VERIFIED_SHA` equals the accepted exact candidate.

## GitHub publication

- [ ] Public history contains one sanitized root commit.
- [ ] Default branch is `main` and branch protection is enabled.
- [ ] Issues and GitHub Private Vulnerability Reporting are enabled.
- [ ] CI and CodeQL pass on the exact public commit.
- [ ] Tag `v0.1.0` points to that commit.
- [ ] An unauthenticated fresh clone completes the documented quickstart.

Publication stops on any failed, skipped, retried, stale, or secret-bearing
evidence.
