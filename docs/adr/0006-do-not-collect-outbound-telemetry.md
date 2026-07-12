# Do not collect outbound telemetry

The project will not transmit analytics, crash reports, usage data, audit
events, or diagnostics to Giggabit or any hosted control plane. Operational
audit records remain local and metadata-only; message bodies remain
memory-only; attachment quarantine remains private and time-limited; and logs
must exclude credentials, addresses, message content, bearer links, and host
paths. An operator may explicitly generate a local, value-suppressed
Diagnostic Report, but the software will never upload it. This keeps a
self-hosted mailbox broker from silently becoming a data processor and leaves
retention and deletion under operator control.
