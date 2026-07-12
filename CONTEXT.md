# Agent Mail Service

This context describes the security boundary between agent runs and explicitly
authorized mailboxes.

## Language

**Production Host**:
A supported machine authorized to run the service against real Mailbox Grants.
_Avoid_: Fleet node, development machine

**Synthetic Environment**:
An isolated development or verification environment that uses only disposable
mail fixtures and cannot access a real Mailbox Grant.
_Avoid_: Test mailbox, local production

**Project Identity**:
The public name and command family of the Giggabit Agent Mail Service.
_Avoid_: Operator identity, provider registration name

**Operator Configuration**:
Deployment-specific settings and identifiers supplied and controlled by the
person or organization running a Production Host.
_Avoid_: Project defaults, bundled credentials

**Provider Registration**:
An OAuth application registration created and controlled by an operator in a
mail provider's identity platform.
_Avoid_: Shared OAuth client, project OAuth account

**MCP Client Integration**:
An optional adapter or configuration that connects a compatible MCP client to
the gateway without changing the gateway's trust boundary.
_Avoid_: Gateway core, trusted client

**Magic-Link Capability**:
An optional operator-authorized flow that lets one agent run consume an
expected passwordless-authentication message without receiving its bearer URL
as plaintext.
_Avoid_: Automatic login, email link opener

**Diagnostic Report**:
A local, explicitly requested summary of value-suppressed system state used to
troubleshoot an installation.
_Avoid_: Telemetry, support bundle

**Administrative Trust Domain**:
The operator-controlled host boundary within which enrolled agent runs are
trusted to use the connected Mailbox Grants.
_Avoid_: Tenant, per-agent authorization boundary
