import type {
  AcpRuntimeConfigOption,
  AcpRuntimeConfigOptionChoice,
} from "../runtime/public/contract.js";

// Generic normalization of ACP session config options (select type) — the
// data-driven sibling of mode-support.ts / model-support.ts. Surfaces every
// select option (model, reasoning effort, …) EXCEPT the "mode" one, which has
// its own dedicated `modes` field + picker. Model option groups are flattened
// into a single choice list so the host renders one plain <select> per option.

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isModeOption(option: Record<string, unknown>): boolean {
  return option.category === "mode" || option.id === "mode";
}

function parseChoice(value: unknown): AcpRuntimeConfigOptionChoice | undefined {
  const option = asRecord(value);
  if (!option || typeof option.value !== "string" || typeof option.name !== "string") {
    return undefined;
  }
  const description = typeof option.description === "string" ? option.description : undefined;
  return { value: option.value, name: option.name, ...(description ? { description } : {}) };
}

// Options can be a flat list of choices or a list of {group, name, options:[]}
// groups (Claude Code's model list). Flatten both into a single choice list.
function parseChoices(value: unknown): AcpRuntimeConfigOptionChoice[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const choices: AcpRuntimeConfigOptionChoice[] = [];
  for (const entry of value) {
    const direct = parseChoice(entry);
    if (direct) {
      choices.push(direct);
      continue;
    }
    const group = asRecord(entry);
    if (group && Array.isArray(group.options)) {
      for (const nested of group.options) {
        const choice = parseChoice(nested);
        if (choice) {
          choices.push(choice);
        }
      }
    }
  }
  return choices;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isNonModeSelect(option: Record<string, unknown>): option is Record<string, unknown> {
  return option.type === "select" && typeof option.id === "string" && !isModeOption(option);
}

function parseConfigOption(value: unknown): AcpRuntimeConfigOption | undefined {
  const option = asRecord(value);
  if (!option || !isNonModeSelect(option)) {
    return undefined;
  }
  const choices = parseChoices(option.options);
  if (choices.length === 0) {
    return undefined;
  }
  const id = option.id as string;
  return {
    id,
    name: optionalString(option.name) ?? id,
    ...(optionalString(option.category) ? { category: option.category as string } : {}),
    ...(optionalString(option.currentValue) ? { currentValue: option.currentValue as string } : {}),
    options: choices,
  };
}

/**
 * Parse the non-mode select config options out of a session's config options.
 * Returns undefined when the agent advertised none, so callers can distinguish
 * "no options" from "empty options".
 */
export function configOptionsFromConfigOptions(
  configOptions: unknown,
): AcpRuntimeConfigOption[] | undefined {
  if (!Array.isArray(configOptions)) {
    return undefined;
  }
  const options: AcpRuntimeConfigOption[] = [];
  for (const entry of configOptions) {
    const parsed = parseConfigOption(entry);
    if (parsed) {
      options.push(parsed);
    }
  }
  return options.length > 0 ? options : undefined;
}
