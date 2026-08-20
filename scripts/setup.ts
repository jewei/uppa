import { spawn, type StdioOptions } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runSetupCli } from "../src/cli/setup-cli";

const CONFIG_PATH = new URL("../wrangler.jsonc", import.meta.url);
const terminal = createInterface({ input, output });

type OutputMode = "capture" | "inherit" | "confirmed";

function run(command: string[], outputMode: OutputMode): Promise<{
  exitCode: number;
  stdout: string;
}> {
  return new Promise((resolve) => {
    let stdout = "";
    const stdio: StdioOptions =
      outputMode === "capture"
        ? ["ignore", "pipe", "ignore"]
        : outputMode === "confirmed"
          ? ["ignore", "inherit", "inherit"]
          : "inherit";
    const child = spawn(command[0] ?? "", command.slice(1), { stdio });
    if (outputMode === "capture" && child.stdout !== null) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
    }
    child.on("error", () => resolve({ exitCode: 1, stdout }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout }));
  });
}

async function writeConfig(source: string): Promise<void> {
  const temporaryPath = new URL(`../wrangler.jsonc.${process.pid}.tmp`, import.meta.url);
  try {
    await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, CONFIG_PATH);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

try {
  process.exitCode = await runSetupCli({
    interactive: Boolean(input.isTTY && output.isTTY),
    prompt: async (message) => terminal.question(`${message}: `),
    confirm: async (message) => {
      const answer = await terminal.question(`${message} [y/N]: `);
      return answer.trim().toLowerCase() === "y";
    },
    write: (message) => console.log(message),
    readConfig: () => readFile(CONFIG_PATH, "utf8"),
    writeConfig,
    runWrangler: (args, outputMode) =>
      run([process.execPath, "x", "wrangler", ...args], outputMode),
    addMonitor: async () =>
      (
        await run(
          [process.execPath, "run", "monitor", "--", "add", "--remote"],
          "inherit",
        )
      ).exitCode,
  });
} catch {
  console.error("Setup failed");
  process.exitCode = 1;
} finally {
  terminal.close();
}
