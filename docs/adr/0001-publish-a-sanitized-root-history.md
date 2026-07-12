# Publish a sanitized root history

The public repository will begin with a single sanitized root commit, while the
existing development repository remains private as provenance. This gives the
public release a history whose entire contents have passed the release scrub
and avoids exposing internal operational details from earlier revisions. The
trade-off is that the original commit-by-commit development history will not
appear in the public repository.
