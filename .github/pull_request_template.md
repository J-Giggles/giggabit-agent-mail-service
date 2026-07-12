## Outcome

Describe the user-visible result.

## Security impact

Describe effects on identity, credentials, untrusted content, outbound mail,
attachments, network exposure, telemetry, and operator policy.

## Verification

- [ ] Red evidence captured before implementation.
- [ ] Focused green tests pass.
- [ ] `./scripts/verify.sh` passes.
- [ ] `./scripts/verify-public-release.sh` passes.
- [ ] Documentation and `CHANGELOG.md` are updated.
- [ ] No real mailbox, credential, provider identifier, message, attachment,
      runtime state, host path, or live log was used.
