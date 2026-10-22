import { evaluateStock } from './policy.mjs';

/** The same evaluator is serialized into AP; no network or external packages in CODE. */
export function dryRunCode() {
  return `export const code = async (inputs) => {
    if (inputs.mode !== 'dry_run' || !Array.isArray(inputs.cases) || inputs.cases.length < 1 || inputs.cases.length > 50) {
      throw new Error('This draft only accepts 1-50 explicit simulation cases in dry_run mode');
    }
    const evaluate = ${evaluateStock.toString()};
    const cases = inputs.cases.map(item => {
      if (item.input?.snapshot?.mode !== 'simulation') throw new Error('Only simulation snapshots are admitted');
      const advice = evaluate(item.input);
      if (item.expectedAction !== advice.action) throw new Error('Scenario mismatch: ' + item.name);
      return { name: item.name, expectedAction: item.expectedAction, advice };
    });
    return { roleId: 'wechat-stock-replenisher', mode: 'dry_run', simulation: true,
      executionPerformed: false, caseCount: cases.length, passed: true, cases };
  };`;
}

export function dryRunFlow() {
  return {
    flowName: '公众号补库专员 · 规则演练（未接生产）',
    trigger: { pieceName: '@activepieces/piece-schedule', triggerName: 'cron_expression',
      input: { cronExpression: '*/30 * * * *', timezone: 'Asia/Shanghai' } },
    steps: [{ type: 'CODE', displayName: '检查10篇下限与15篇目标（仅模拟）', sourceCode: dryRunCode(),
      input: { mode: 'dry_run', cases: "{{trigger['output'].cases}}" },
      continueOnFailure: false, retryOnFailure: false }],
  };
}
