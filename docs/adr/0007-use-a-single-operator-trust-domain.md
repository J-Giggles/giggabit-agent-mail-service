# Use a single-operator Administrative Trust Domain

Public v1 will be a self-hosted, single-operator service, not a multi-tenant
mail platform. One operator controls each Production Host and chooses which
Mailbox Grants to make available inside its Administrative Trust Domain.
Short-lived Agent Mail Identities provide attribution, request proof,
revocation, and containment, but do not imply per-agent grant or capability
authorization; an enrolled agent that knows a grant identifier may use that
grant. Operators requiring separation between mutually untrusted users must
use separate hosts or OS-level trust domains. The docs will state this limit
plainly and list per-agent policy as future work rather than suggesting a
security control the gateway does not enforce.
