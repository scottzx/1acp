import type {
  AcpRuntimeSessionModeInfo,
  AcpRuntimeSessionModes,
} from "../runtime/public/contract.js";

// Session-mode extraction from ACP config options — the mode-flavored sibling
// of model-support.ts modelStateFromConfigOptions. Agents advertise their mode
// list as a select config option (claude-agent-acp and codex-acp both do);
// the option's currentValue is the mode at snapshot time.

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isModeSelectOption(option: Record<string, unknown>): boolean {
  return option.type === "select" && (option.category === "mode" || option.id === "mode");
}

function parseAvailableMode(value: unknown): AcpRuntimeSessionModeInfo | undefined {
  const option = asRecord(value);
  if (!option || typeof option.value !== "string" || typeof option.name !== "string") {
    return undefined;
  }
  const description = typeof option.description === "string" ? option.description : undefined;
  return {
    id: option.value,
    name: option.name,
    ...(description ? { description } : {}),
  };
}

function parseModeOption(option: Record<string, unknown>): AcpRuntimeSessionModes {
  const rawModes = Array.isArray(option.options) ? option.options : [];
  const availableModes: AcpRuntimeSessionModeInfo[] = [];
  for (const rawMode of rawModes) {
    const mode = parseAvailableMode(rawMode);
    if (mode) {
      availableModes.push(mode);
    }
  }
  const currentModeId =
    typeof option.currentValue === "string" && option.currentValue !== ""
      ? option.currentValue
      : undefined;
  return {
    ...(currentModeId ? { currentModeId } : {}),
    availableModes,
  };
}

/**
 * Parse the mode select option out of a session's config options. Returns
 * undefined when the agent never advertised one (mode-less agents), so
 * callers can distinguish "no modes" from "empty modes".
 */
export function modeStateFromConfigOptions(
  configOptions: unknown,
): AcpRuntimeSessionModes | undefined {
  if (!Array.isArray(configOptions)) {
    return undefined;
  }
  for (const entry of configOptions) {
    const option = asRecord(entry);
    if (option && isModeSelectOption(option)) {
      return parseModeOption(option);
    }
  }
  return undefined;
}
