/** Execution interfaces shared by DSH and future standalone A2A hosts. */
import type { SafeError } from '@1agents/acp-service/runtime';

export interface A2ATarget {
  sessionId: string;
  cwd: string;
  agentPreset?: string;
}

/** Omitted location and preset reuse a saved context or the host defaults. */
export interface A2APrepareInput {
  sessionId?: string;
  cwd?: string;
  agentPreset?: string;
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
  prepare(input: A2APrepareInput): Promise<A2ATarget>;
  run(target: A2ATarget, prompt: string, options: { requestId: string; signal: AbortSignal }): Promise<A2ARunResult>;
}
