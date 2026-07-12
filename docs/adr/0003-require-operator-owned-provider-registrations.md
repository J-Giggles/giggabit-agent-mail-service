# Require operator-owned provider registrations

The project will retain the Giggabit Agent Mail Service identity and public
GitHub attribution, but it will not distribute or operate shared Microsoft
Entra or Google OAuth client identities. Each operator must create and control
their own Provider Registrations and supply only their deployment-specific
identifiers through documented Operator Configuration. Public documentation
will explain provider setup and required least-privilege permissions, while
provider tenancy, consent, verification, quotas, and account administration
remain the operator's responsibility. This avoids turning the open-source
project into a credential broker or hosted identity dependency and prevents
one operator's abuse or revocation from affecting others.
