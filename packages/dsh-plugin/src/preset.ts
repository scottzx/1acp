/** A standing preset binds its sessions to one external Agent. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
export const name = 'oneagents-acp-preset';
export const inject = ['agents', 'llm'];
export function apply(ctx: Context, config: { agent: string }): void {
  if (!/^[a-z0-9_-]+$/i.test(config.agent)) throw new Error('Invalid ACP Agent name');
  ctx.on('agent/request', async (_event, next) => {
    await next();
    return { provider: '1agents-acp', model: config.agent };
  });
}
