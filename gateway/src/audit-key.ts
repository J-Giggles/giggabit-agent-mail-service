import { hkdfSync } from "node:crypto";

const AUDIT_KEY_LABEL = "giggabit-agent-mail-service-audit-v1";

export function deriveAuditKey(masterKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), AUDIT_KEY_LABEL, 32));
}
