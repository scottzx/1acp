import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ACP_ADAPTER_PACKAGE_RANGES = {
  pi: "^0.0.26",
  codex: "^1.1.0",
  claude: "^0.37.0",
  mux: "^0.27.0",
  opencode: "^1.17.0",
} as const;

type BuiltInAgentPackageSpec = {
  packageName: string;
  packageRange: string;
  preferredBinName: string;
  fallbackCommand: string;
  legacyFallbackCommands?: string[];
  extraArgs?: string[];
  /** Set when the resolved bin is a native executable and must be spawned directly, not via `node <binPath>`. */
  nativeBinary?: boolean;
};

type BuiltInAgentLaunch = {
  source: "installed" | "package-exec";
  command: string;
  args: string[];
  packageName: string;
  packageRange: string;
  packageVersion?: string;
  binPath?: string;
  npmCliPath?: string;
};

type BuiltInLaunchResolverOptions = {
  existsSync?: (path: string) => boolean;
  readFileSync?: typeof fs.readFileSync;
  resolvePackageRoot?: (packageName: string) => string;
  execPath?: string;
  resolveNpmCliPath?: (execPath: string) => string;
};

export const AGENT_REGISTRY: Record<string, string> = {
  pi: `npx pi-acp@${ACP_ADAPTER_PACKAGE_RANGES.pi}`,
  openclaw: "openclaw acp",
  codex: `npx -y @agentclientprotocol/codex-acp@${ACP_ADAPTER_PACKAGE_RANGES.codex}`,
  claude: `npx -y @agentclientprotocol/claude-agent-acp@${ACP_ADAPTER_PACKAGE_RANGES.claude}`,
  gemini: "gemini --acp",
  cursor: "cursor-agent acp",
  copilot: "copilot --acp --stdio",
  droid: "droid exec --output-format acp",
  "fast-agent": "uvx fast-agent-mcp acp",
  iflow: "iflow --experimental-acp",
  kilocode: "npx -y @kilocode/cli acp",
  kimi: "kimi acp",
  kiro: "kiro-cli-chat acp",
  mux: `npx -y mux@${ACP_ADAPTER_PACKAGE_RANGES.mux} acp`,
  opencode: "npx -y opencode-ai acp",
  qoder: "qodercli --acp",
  qwen: "qwen --acp",
  trae: "traecli acp serve",
};

export const BUILT_IN_AGENT_PACKAGES = {
  pi: {
    packageName: "pi-acp",
    packageRange: ACP_ADAPTER_PACKAGE_RANGES.pi,
    preferredBinName: "pi-acp",
    fallbackCommand: AGENT_REGISTRY.pi,
    legacyFallbackCommands: [],
  },
  codex: {
    packageName: "@agentclientprotocol/codex-acp",
    packageRange: ACP_ADAPTER_PACKAGE_RANGES.codex,
    preferredBinName: "codex-acp",
    fallbackCommand: AGENT_REGISTRY.codex,
    legacyFallbackCommands: [],
  },
  claude: {
    packageName: "@agentclientprotocol/claude-agent-acp",
    packageRange: ACP_ADAPTER_PACKAGE_RANGES.claude,
    preferredBinName: "claude-agent-acp",
    fallbackCommand: AGENT_REGISTRY.claude,
    legacyFallbackCommands: [
      `npm exec @agentclientprotocol/claude-agent-acp@${ACP_ADAPTER_PACKAGE_RANGES.claude}`,
    ],
  },
  opencode: {
    packageName: "opencode-ai",
    packageRange: ACP_ADAPTER_PACKAGE_RANGES.opencode,
    preferredBinName: "opencode",
    fallbackCommand: AGENT_REGISTRY.opencode,
    legacyFallbackCommands: [],
    extraArgs: ["acp"],
    nativeBinary: true,
  },
} as const satisfies Record<string, BuiltInAgentPackageSpec>;

const AGENT_ALIASES: Record<string, string> = {
  "factory-droid": "droid",
  factorydroid: "droid",
  claudecode: "claude",
};

export const DEFAULT_AGENT_NAME = "codex";

export function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase();
}

export function mergeAgentRegistry(overrides?: Record<string, string>): Record<string, string> {
  if (!overrides) {
    return { ...AGENT_REGISTRY };
  }

  const merged = { ...AGENT_REGISTRY };
  for (const [name, command] of Object.entries(overrides)) {
    const normalized = normalizeAgentName(name);
    if (!normalized || !command.trim()) {
      continue;
    }
    merged[normalized] = command.trim();
  }
  return merged;
}

export function resolveAgentCommand(agentName: string, overrides?: Record<string, string>): string {
  const normalized = normalizeAgentName(agentName);
  const registry = mergeAgentRegistry(overrides);
  return registry[normalized] ?? registry[AGENT_ALIASES[normalized] ?? normalized] ?? agentName;
}

export function findBuiltInAgentPackage(agentCommand: string): BuiltInAgentPackageSpec | undefined {
  const normalized = agentCommand.trim();
  const builtInAgentPackages = Object.values(BUILT_IN_AGENT_PACKAGES) as BuiltInAgentPackageSpec[];
  return builtInAgentPackages.find(
    (spec) =>
      spec.fallbackCommand === normalized || spec.legacyFallbackCommands?.includes(normalized),
  );
}

function defaultResolvePackageRoot(packageName: string): string {
  const segments = packageName.split("/");
  let cursor = path.dirname(fileURLToPath(import.meta.url));

  while (true) {
    const candidateRoot = path.join(cursor, "node_modules", ...segments);
    const manifestPath = path.join(candidateRoot, "package.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
          name?: string;
        };
        if (parsed.name === packageName) {
          return candidateRoot;
        }
      } catch {
        // best effort; keep walking upward
      }
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`Built-in agent package not found: ${packageName}`);
    }
    cursor = parent;
  }
}

function resolvePackageBin(
  spec: BuiltInAgentPackageSpec,
  manifest: {
    bin?: string | Record<string, string>;
  },
): string | undefined {
  if (typeof manifest.bin === "string") {
    return manifest.bin;
  }
  if (!manifest.bin || typeof manifest.bin !== "object") {
    return undefined;
  }
  return (
    manifest.bin[spec.preferredBinName] ??
    (Object.keys(manifest.bin).length === 1 ? Object.values(manifest.bin)[0] : undefined)
  );
}

function defaultResolveNpmCliPath(execPath: string): string {
  const candidate = path.resolve(
    path.dirname(execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (!fs.existsSync(candidate)) {
    throw new Error(`npm CLI not found for execPath: ${execPath}`);
  }
  return candidate;
}

function getResolveOptions(options: BuiltInLaunchResolverOptions) {
  return {
    readFileSync: options.readFileSync ?? fs.readFileSync,
    existsSync: options.existsSync ?? fs.existsSync,
    resolvePackageRoot: options.resolvePackageRoot ?? defaultResolvePackageRoot,
    execPath: options.execPath ?? process.execPath,
    resolveNpmCliPath: options.resolveNpmCliPath ?? defaultResolveNpmCliPath,
  };
}

export function resolveInstalledBuiltInAgentLaunch(
  agentCommand: string,
  options: BuiltInLaunchResolverOptions = {},
): BuiltInAgentLaunch | undefined {
  const spec = findBuiltInAgentPackage(agentCommand);
  if (!spec) {
    return undefined;
  }

  const { readFileSync, existsSync, resolvePackageRoot } = getResolveOptions(options);

  try {
    const resolved = resolveInstalledBuiltInAgentPackage(spec, {
      readFileSync,
      existsSync,
      resolvePackageRoot,
    });
    if (!resolved) {
      return undefined;
    }

    const args: string[] = spec.nativeBinary ? [] : [resolved.binPath];
    if (spec.extraArgs) {
      args.push(...spec.extraArgs);
    }

    return {
      source: "installed",
      command: spec.nativeBinary ? resolved.binPath : process.execPath,
      args,
      packageName: spec.packageName,
      packageRange: spec.packageRange,
      packageVersion: resolved.packageVersion,
      binPath: resolved.binPath,
    };
  } catch {
    return undefined;
  }
}

function resolveInstalledBuiltInAgentPackage(
  spec: BuiltInAgentPackageSpec,
  options: Required<
    Pick<BuiltInLaunchResolverOptions, "readFileSync" | "existsSync" | "resolvePackageRoot">
  >,
): { packageVersion?: string; binPath: string } | undefined {
  const packageRoot = options.resolvePackageRoot(spec.packageName);
  const manifest = JSON.parse(
    options.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as {
    name?: string;
    version?: string;
    bin?: string | Record<string, string>;
  };
  if (manifest.name !== spec.packageName) {
    return undefined;
  }

  const relativeBinPath = resolvePackageBin(spec, manifest);
  if (!relativeBinPath) {
    return undefined;
  }

  const binPath = path.resolve(packageRoot, relativeBinPath);
  return options.existsSync(binPath) ? { packageVersion: manifest.version, binPath } : undefined;
}

export function resolvePackageExecBuiltInAgentLaunch(
  agentCommand: string,
  options: BuiltInLaunchResolverOptions = {},
): BuiltInAgentLaunch | undefined {
  const spec = findBuiltInAgentPackage(agentCommand);
  if (!spec) {
    return undefined;
  }

  const { existsSync, execPath, resolveNpmCliPath } = getResolveOptions(options);

  try {
    const npmCliPath = resolveNpmCliPath(execPath);
    if (!existsSync(npmCliPath)) {
      return undefined;
    }

    const args = [
      npmCliPath,
      "exec",
      "--yes",
      `--package=${spec.packageName}@${spec.packageRange}`,
      "--",
      spec.preferredBinName,
    ];
    if (spec.extraArgs) {
      args.push(...spec.extraArgs);
    }

    return {
      source: "package-exec",
      command: execPath,
      args,
      packageName: spec.packageName,
      packageRange: spec.packageRange,
      npmCliPath,
    };
  } catch {
    return undefined;
  }
}

export function resolveBuiltInAgentLaunch(
  agentCommand: string,
  options: BuiltInLaunchResolverOptions = {},
): BuiltInAgentLaunch | undefined {
  return (
    resolveInstalledBuiltInAgentLaunch(agentCommand, options) ??
    resolvePackageExecBuiltInAgentLaunch(agentCommand, options)
  );
}

export function listBuiltInAgents(overrides?: Record<string, string>): string[] {
  return Object.keys(mergeAgentRegistry(overrides));
}
