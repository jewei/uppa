import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runMonitorCli } from "../src/cli/monitor-cli";
import { executeWranglerSql } from "../src/cli/wrangler-executor";

const terminal = createInterface({ input, output });

try {
  const exitCode = await runMonitorCli(process.argv.slice(2), {
    prompt: async (message) => terminal.question(`${message}: `),
    confirm: async (message) => {
      const answer = await terminal.question(`${message} [y/N]: `);
      return answer.trim().toLowerCase() === "y";
    },
    write: (message) => console.log(message),
    execute: executeWranglerSql,
    now: Date.now,
    randomId: () => crypto.randomUUID(),
  });
  process.exitCode = exitCode;
} catch (error) {
  // Print the message, never the error object. A stack would expose file paths
  // and, worse, an attached stdout that can contain the SQL and therefore the
  // monitor URLs. The message is already sanitised by sanitizedWranglerError,
  // which extracts the Cloudflare API's diagnosis and drops everything else.
  console.error(
    error instanceof Error && error.message !== ""
      ? `Monitor command failed: ${error.message}`
      : "Monitor command failed",
  );
  process.exitCode = 1;
} finally {
  terminal.close();
}
