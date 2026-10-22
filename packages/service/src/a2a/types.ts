/** Execution interfaces shared by DSH and future standalone A2A hosts. */
import type { SafeError } from '@1agents/acp-service/runtime';

/** Explicit host-side requirements checked without creating an agent session. */
export interface A2APreflightRequirements {
  allowedDirectories?: string[];
  jobDirectory?: string;
  requiredFiles?: string[];
  python?: { executable: string; modules: string[] };
  node?: { executable: string; modules?: string[]; moduleRoot?: string };
}
export interface A2APreflightInput extends A2APreflightRequirements { cwd: string }
export interface A2APreflightReport {
  ok: boolean;
  checkedAt: string;
  cwd: string;
  jobDirectory?: string;
  checks: { id: string; ok: boolean; detail?: string }[];
}

export interface A2ATarget {
  sessionId: string;
  cwd: string;
  agentPreset?: string;
  preflight?: A2APreflightReport;
}

/** Omitted location and preset reuse a saved context or the host defaults. */
export interface A2APrepareInput {
  sessionId?: string;
  cwd?: string;
  agentPreset?: string;
  preflight?: A2APreflightRequirements;
}

/** A single DSH turn's output, without transport or host dependencies. */
export interface A2ARunResult {
  text: string;
  outcome: 'completed' | 'failed' | 'input-required';
  detail?: string;
  /** Bounded, safe failure context; execution state is independent of recovery policy. */
  error?: SafeError;
  /** Known host endings select a fixed explanation without forwarding raw detail. */
  failureReason?: 'missing-final-answer' | 'max-tokens' | 'forked' | 'unsupported-ending'
    | 'discarded' | 'disposed' | 'aborted' | 'interrupted';
}

/** Implementations own session admission, execution and precise cancellation. */
export interface A2ABackend {
  /** Does not allocate a session or submit a model prompt. */
  preflight?(input: A2APreflightInput): Promise<A2APreflightReport>;
  /** Optional read-only reconciliation; never resumes or repeats execution. */
  recover?(target: A2ATarget, options: { requestId: string }): Promise<SafeError | undefined>;
  prepare(input: A2APrepareInput): Promise<A2ATarget>;
  run(target: A2ATarget, prompt: string, options: { requestId: string; signal: AbortSignal }): Promise<A2ARunResult>;
}
