import path from "node:path";
import type { FixtureConfig, Source } from "./preflight-context.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Keep short probes independent of Node's cold start under parallel test load. */
export function preflightLauncher(
  peerPath: string,
  configPath: string,
  config: FixtureConfig,
  source: Source,
): string {
  const profile = config.profiles[source];
  if (!profile) {
    throw new Error("Missing synthetic peer profile");
  }
  const execPeer = `exec ${[process.execPath, peerPath, "peer", configPath, source].map(quote).join(" ")} "$@"\n`;
  // Held probes still need the real process/descendant lifecycle fixture.
  if (profile.probeBehavior) {
    return `#!/bin/sh\n[ "$1" = --fixture-ready ] && exit 0\n${execPeer}`;
  }
  const tracePath = quote(path.join(config.root, "trace.jsonl"));
  const help = profile.flag ? "Usage: copilot --acp --stdio" : "Usage: copilot";
  return (
    String.raw`#!/bin/bash
case "$1" in
  --fixture-ready) exit 0 ;;
  --version|--help)
    # Read the actual child cwd and environment, rather than expected config values.
    cwd="$(pwd -P)"
    cwd="${"$"}{cwd//\\/\\\\}"
    cwd="${"$"}{cwd//\"/\\\"}"
    cwd="${"$"}{cwd//$'\n'/\\n}"
    cwd="${"$"}{cwd//$'\r'/\\r}"
    cwd="${"$"}{cwd//$'\t'/\\t}"
    gemini=false
    google=false
    [ -n "$GEMINI_API_KEY" ] && gemini=true
    [ -n "$GOOGLE_API_KEY" ] && google=true
` +
    `    printf '{"event":"invocation","pid":%d,"parentPid":%d,"source":"${source}","args":["%s"],"cwd":"%s","hasGeminiKey":%s,"hasGoogleKey":%s}\\n' "$$" "$PPID" "$1" "$cwd" "$gemini" "$google" >> ${tracePath}\n` +
    `    if [ "$1" = --version ]; then printf '%s\\n' ${quote(profile.version)}; else printf '%s\\n' ${quote(help)}; fi\n` +
    "    exit 0\n    ;;\nesac\n" +
    execPeer
  );
}
