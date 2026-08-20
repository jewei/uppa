const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const DATABASE_NAME = "edge-uptime";

type CommandOutput = "capture" | "inherit" | "confirmed";

interface CommandResult {
  exitCode: number;
  stdout: string;
}

export interface SetupCliDependencies {
  interactive: boolean;
  prompt(message: string): Promise<string>;
  confirm(message: string): Promise<boolean>;
  write(message: string): void;
  readConfig(): Promise<string>;
  writeConfig(source: string): Promise<void>;
  runWrangler(args: string[], output: CommandOutput): Promise<CommandResult>;
  addMonitor(): Promise<number>;
}

interface ConfigValues {
  databaseId: string;
  siteName: string;
  siteDescription: string;
}

interface D1Database {
  name: string;
  uuid: string;
}

function readStringProperty(source: string, key: string): string {
  const pattern = new RegExp(
    `"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`,
    "gu",
  );
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error(`Expected one ${key} property in wrangler.jsonc`);
  }
  const value: unknown = JSON.parse(matches[0][1]);
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string in wrangler.jsonc`);
  }
  return value;
}

function replaceStringProperty(source: string, key: string, value: string): string {
  const pattern = new RegExp(
    `("${key}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`,
    "gu",
  );
  const matches = source.match(pattern);
  if (matches?.length !== 1) {
    throw new Error(`Expected one ${key} property in wrangler.jsonc`);
  }
  return source.replace(
    pattern,
    (_match, prefix: string) => `${prefix}${JSON.stringify(value)}`,
  );
}

function readConfigValues(source: string): ConfigValues {
  return {
    databaseId: readStringProperty(source, "database_id"),
    siteName: readStringProperty(source, "SITE_NAME"),
    siteDescription: readStringProperty(source, "SITE_DESCRIPTION"),
  };
}

export function updateWranglerConfig(
  source: string,
  values: ConfigValues,
): string {
  const withDatabase = replaceStringProperty(
    source,
    "database_id",
    values.databaseId,
  );
  const withName = replaceStringProperty(
    withDatabase,
    "SITE_NAME",
    values.siteName,
  );
  return replaceStringProperty(
    withName,
    "SITE_DESCRIPTION",
    values.siteDescription,
  );
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const jsonStart = trimmed.lastIndexOf("\n[");
    if (jsonStart === -1) throw new Error("Invalid Wrangler response");
    return JSON.parse(trimmed.slice(jsonStart + 1)) as unknown;
  }
}

function parseD1Databases(stdout: string): D1Database[] {
  const value = parseJsonOutput(stdout);
  if (!Array.isArray(value)) throw new Error("Invalid Wrangler response");

  return value.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("Invalid Wrangler response");
    }
    const database = item as Record<string, unknown>;
    if (typeof database.name !== "string" || typeof database.uuid !== "string") {
      throw new Error("Invalid Wrangler response");
    }
    return { name: database.name, uuid: database.uuid };
  });
}

function validDatabaseId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

async function listDatabases(
  dependencies: SetupCliDependencies,
): Promise<D1Database[] | null> {
  const result = await dependencies.runWrangler(["d1", "list", "--json"], "capture");
  if (result.exitCode !== 0) {
    dependencies.write("Could not list D1 databases");
    return null;
  }
  try {
    return parseD1Databases(result.stdout);
  } catch {
    dependencies.write("Wrangler returned an invalid D1 database list");
    return null;
  }
}

async function resolveDatabaseId(
  currentId: string,
  dependencies: SetupCliDependencies,
): Promise<string | null> {
  if (currentId !== PLACEHOLDER_DATABASE_ID) {
    if (!validDatabaseId(currentId)) {
      dependencies.write("wrangler.jsonc contains an invalid D1 database ID");
      return null;
    }
    return currentId;
  }

  const initialDatabases = await listDatabases(dependencies);
  if (initialDatabases === null) return null;
  const matches = initialDatabases.filter((database) => database.name === DATABASE_NAME);
  if (matches.length > 1) {
    dependencies.write(`More than one D1 database is named ${DATABASE_NAME}`);
    return null;
  }
  if (matches[0] !== undefined) {
    if (!(await dependencies.confirm(`Use the existing ${DATABASE_NAME} D1 database?`))) {
      dependencies.write("Setup cancelled");
      return null;
    }
    return matches[0].uuid;
  }

  if (!(await dependencies.confirm(`Create the remote ${DATABASE_NAME} D1 database?`))) {
    dependencies.write("Setup cancelled");
    return null;
  }
  const creation = await dependencies.runWrangler(
    ["d1", "create", DATABASE_NAME],
    "inherit",
  );
  if (creation.exitCode !== 0) {
    dependencies.write("Could not create the D1 database");
    return null;
  }

  const createdDatabases = await listDatabases(dependencies);
  if (createdDatabases === null) return null;
  const created = createdDatabases.filter(
    (database) => database.name === DATABASE_NAME,
  );
  if (created.length !== 1 || created[0] === undefined) {
    dependencies.write(`Could not find the new ${DATABASE_NAME} D1 database`);
    return null;
  }
  return created[0].uuid;
}

function publicSetting(
  input: string,
  current: string,
  label: string,
  maximumLength: number,
  dependencies: SetupCliDependencies,
): string | null {
  const value = input.trim() || current;
  if (value.length === 0 || value.length > maximumLength) {
    dependencies.write(`${label} must contain 1 through ${maximumLength} characters`);
    return null;
  }
  return value;
}

async function authenticate(dependencies: SetupCliDependencies): Promise<boolean> {
  const identity = await dependencies.runWrangler(["whoami", "--json"], "capture");
  if (identity.exitCode === 0) return true;

  if (!(await dependencies.confirm("Wrangler is not authenticated. Start login?"))) {
    dependencies.write("Setup cancelled");
    return false;
  }
  const login = await dependencies.runWrangler(["login"], "inherit");
  if (login.exitCode !== 0) {
    dependencies.write("Wrangler login failed");
    return false;
  }
  const authenticated = await dependencies.runWrangler(
    ["whoami", "--json"],
    "capture",
  );
  if (authenticated.exitCode !== 0) {
    dependencies.write("Wrangler authentication could not be verified");
    return false;
  }
  return true;
}

export async function runSetupCli(
  dependencies: SetupCliDependencies,
): Promise<number> {
  if (!dependencies.interactive) {
    dependencies.write("Run setup in an interactive terminal");
    return 1;
  }

  dependencies.write("Uppa setup");
  dependencies.write("Each remote change requires confirmation.");

  if (!(await authenticate(dependencies))) return 1;

  let source: string;
  let current: ConfigValues;
  try {
    source = await dependencies.readConfig();
    current = readConfigValues(source);
  } catch {
    dependencies.write("Could not read the required values from wrangler.jsonc");
    return 1;
  }

  const databaseId = await resolveDatabaseId(current.databaseId, dependencies);
  if (databaseId === null) return 1;

  const siteName = publicSetting(
    await dependencies.prompt(`Site name [${current.siteName}]`),
    current.siteName,
    "Site name",
    100,
    dependencies,
  );
  if (siteName === null) return 1;
  const siteDescription = publicSetting(
    await dependencies.prompt(`Site description [${current.siteDescription}]`),
    current.siteDescription,
    "Site description",
    200,
    dependencies,
  );
  if (siteDescription === null) return 1;

  const updatedSource = updateWranglerConfig(source, {
    databaseId,
    siteName,
    siteDescription,
  });
  if (updatedSource !== source) {
    await dependencies.writeConfig(updatedSource);
    dependencies.write("Updated wrangler.jsonc");
  }

  if (!(await dependencies.confirm("Apply remote D1 migrations?"))) {
    dependencies.write("Setup stopped before migration");
    return 0;
  }
  const migration = await dependencies.runWrangler(
    ["d1", "migrations", "apply", DATABASE_NAME, "--remote"],
    "confirmed",
  );
  if (migration.exitCode !== 0) {
    dependencies.write("Remote D1 migration failed");
    return 1;
  }

  if (!(await dependencies.confirm("Deploy Uppa to Cloudflare?"))) {
    dependencies.write("Setup stopped before deployment");
    return 0;
  }
  const deployment = await dependencies.runWrangler(["deploy"], "inherit");
  if (deployment.exitCode !== 0) {
    dependencies.write("Deployment failed");
    return 1;
  }

  if (await dependencies.confirm("Configure webhook notifications?")) {
    const secret = await dependencies.runWrangler(
      ["secret", "put", "WEBHOOK_URL"],
      "inherit",
    );
    if (secret.exitCode !== 0) {
      dependencies.write("Webhook configuration failed");
      return 1;
    }
  }

  if (await dependencies.confirm("Add the first monitor now?")) {
    if ((await dependencies.addMonitor()) !== 0) {
      dependencies.write("Monitor configuration failed");
      return 1;
    }
  }

  dependencies.write("Uppa setup is complete");
  return 0;
}
