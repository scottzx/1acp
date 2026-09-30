import Module, { register } from "node:module";
import { fileURLToPath } from "node:url";

type ResolveFilename = (
  specifier: string,
  parent: unknown,
  isMain?: boolean,
  options?: unknown,
) => string;

const moduleResolver = Module as unknown as { _resolveFilename: ResolveFilename };
const resolveFilenameKey = "_resolveFilename";
let installed = false;

/** Resolve the public flow entrypoint in both ESM and CommonJS dependency graphs. */
export function installFlowRuntimeResolution(runtimeUrl: string): void {
  if (installed) {
    return;
  }
  const hook = `
    let runtimeUrl;
    const flowSpecifiers = new Set(["acpx/flows", "@scottzx/1acp/flows"]);
    export function initialize(data) { runtimeUrl = data.runtimeUrl; }
    export function resolve(specifier, context, nextResolve) {
      return nextResolve(flowSpecifiers.has(specifier) ? runtimeUrl : specifier, context);
    }
  `;
  register(`data:text/javascript,${encodeURIComponent(hook)}`, { data: { runtimeUrl } });
  // Node 22.13 supports ESM hooks but predates synchronous CommonJS hooks.
  const resolve = moduleResolver[resolveFilenameKey];
  const runtimePath = fileURLToPath(runtimeUrl);
  const flowSpecifiers = new Set(["acpx/flows", "@scottzx/1acp/flows"]);
  moduleResolver[resolveFilenameKey] = function (specifier, parent, isMain, options) {
    return resolve.call(
      this,
      flowSpecifiers.has(specifier) ? runtimePath : specifier,
      parent,
      isMain,
      options,
    );
  };
  installed = true;
}
