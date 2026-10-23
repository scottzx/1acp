import { evaluateStock } from './policy.mjs';

export function productionFlow(connectionExternalId) {
  if (typeof connectionExternalId !== 'string' || !connectionExternalId.trim()) throw new Error('Encrypted AP connection externalId is required');
  const networkStep = (displayName, actionName, input) => ({ type: 'PIECE', displayName, pieceName: '@1agents/piece-wechat-stock',
    actionName, auth: connectionExternalId, input, retryOnFailure: false, continueOnFailure: false });
  return { flowName: '公众号系列批量制作 · 3并发执行全清单',
    trigger: { pieceName: '@activepieces/piece-schedule', triggerName: 'cron_expression', input: { cronExpression: '*/30 * * * *', timezone: 'Asia/Shanghai' } },
    steps: [networkStep('读取真实候补库存与已有结果', 'observe_stock', {}),
      { type: 'CODE', displayName: '按当前模式计算下一批制作',
        sourceCode: `export const code = async (inputs) => { const observation = inputs.observation;
          if (observation?.due !== true) return { observationId: '', advice: { action: 'wait_interval', shouldDispatch: false, executionPerformed: false } };
          const evaluate = ${evaluateStock.toString()}; return { observationId: observation.observationId, advice: evaluate(observation.input) }; };`,
        input: { observation: "{{step_1['output']}}" }, retryOnFailure: false, continueOnFailure: false },
      networkStep('保存批次并执行下一动作', 'apply_stock_advice', { observationId: "{{step_2['output'].observationId}}", advice: "{{step_2['output'].advice}}" })] };
}
