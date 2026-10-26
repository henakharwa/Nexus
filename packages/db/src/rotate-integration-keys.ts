// One-time operator command for encryption-key rotation. Keep both the new
// active key and every old key in INTEGRATION_ENCRYPTION_KEYS while it runs.
import "dotenv/config";
import { closePool } from "./pool.js";
import { reencryptIntegrationCredentials } from "./integrations.js";

try {
  const rotated = await reencryptIntegrationCredentials();
  console.log(`Re-encrypted ${rotated} integration credential${rotated === 1 ? "" : "s"}.`);
} finally {
  await closePool();
}
