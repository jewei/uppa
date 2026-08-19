import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLIENT_BUILD = "dist/client";
const STARTUP_TIMEOUT_MS = 20_000;

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return nested.flat();
}

async function verifyPublicArtifacts(): Promise<void> {
  const files = await filesUnder(CLIENT_BUILD);
  if (!files.some((path) => path.endsWith("index.html"))) {
    throw new Error("Client build is missing index.html");
  }

  for (const path of files) {
    const contents = await readFile(path, "utf8");
    const publicContents = contents.replaceAll("http://www.w3.org/2000/svg", "");
    const resourceIds = publicContents.match(
      /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu,
    );
    const hasBoundResource = resourceIds?.some(
      (id) => id !== "00000000-0000-0000-0000-000000000000",
    );
    if (
      /https?:\/\//u.test(publicContents) ||
      /WEBHOOK_URL|database_id/iu.test(publicContents) ||
      hasBoundResource === true
    ) {
      throw new Error(`Public artifact contains private configuration: ${path}`);
    }
  }

  const html = await readFile(join(CLIENT_BUILD, "index.html"), "utf8");
  const assetPaths = [...html.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/gu)].map(
    (match) => match[1],
  );
  if (assetPaths.length === 0) throw new Error("Client build references no assets");
  const available = new Set(files);
  for (const assetPath of assetPaths) {
    if (assetPath === undefined || !available.has(join(CLIENT_BUILD, assetPath))) {
      throw new Error("Client build references a missing asset");
    }
  }
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local port"));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolve(address.port);
        else reject(error);
      });
    });
  });
}

function wrangler(arguments_: string[], output: "pipe" | "ignore"): ChildProcess {
  return spawn(process.execPath, ["x", "wrangler", ...arguments_], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", output, output],
  });
}

async function waitForSuccess(child: ChildProcess): Promise<void> {
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) throw new Error("Local Wrangler command failed");
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function verifyFreshLocalRuntime(): Promise<void> {
  const persistence = await mkdtemp(join(tmpdir(), "edge-uptime-verify-"));
  let server: ChildProcess | null = null;
  try {
    await waitForSuccess(
      wrangler(
        [
          "d1",
          "migrations",
          "apply",
          "edge-uptime",
          "--local",
          "--persist-to",
          persistence,
        ],
        "ignore",
      ),
    );

    const port = await availablePort();
    server = wrangler(
      [
        "dev",
        "--persist-to",
        persistence,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      "ignore",
    );
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let statusResponse: Response | null = null;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error("Local Worker exited during startup");
      try {
        const response = await fetch(`${origin}/api/status`);
        if (response.ok) {
          statusResponse = response;
          break;
        }
      } catch {
        // The local listener is not ready yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (statusResponse === null) throw new Error("Local Worker did not start");
    const status: unknown = await statusResponse.json();
    if (
      typeof status !== "object" ||
      status === null ||
      (status as { overallStatus?: unknown }).overallStatus !== "unknown"
    ) {
      throw new Error("Local Worker returned an invalid empty status response");
    }

    const page = await fetch(origin);
    if (!page.ok || !(await page.text()).includes('<main class="shell">')) {
      throw new Error("Local SPA smoke test failed");
    }
  } finally {
    if (server !== null) await stop(server);
    await rm(persistence, { force: true, recursive: true });
  }
}

await verifyPublicArtifacts();
await verifyFreshLocalRuntime();
console.log("Verified public artifacts, fresh migration, Worker, and SPA");
