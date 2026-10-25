/** Scope-owned model route for the draft uploader's standard-mode backup. */
export const name = 'wechat-mp-draft-model-route';
export const inject = ['llm', 'systemPrompt'];

/** Register scoped waterfalls without changing the Host model default. */
export function apply(ctx, config) {
  if (!config || typeof config.provider !== 'string' || !config.provider.trim()
    || typeof config.model !== 'string' || !config.model.trim()) {
    throw new Error('Draft uploader model route requires nonempty provider and model');
  }
  const { provider, model } = config;
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next();
    return { ...assembled, variables: { ...assembled.variables, provider, model } };
  }, { prepend: true });
  ctx.on('agent/request', async (_payload, next) => {
    const resolved = await next();
    // An effort selected for the previous provider must not reach the new route.
    const { reasoningEffort: _inheritedEffort, ...controls } = resolved;
    return { ...controls, provider, model };
  }, { prepend: true });
}
