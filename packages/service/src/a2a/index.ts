/** Shared A2A 1.0 server, persistent state and host-independent executor interfaces. */
export { createA2AServer } from './server.js';
export type { A2AServerOptions } from './server.js';
export { FileA2AStore } from './store.js';
export type { A2ABackend, A2APrepareInput, A2ARunResult, A2ATarget } from './types.js';
export { RemoteAgentGateway, serveA2AGateway, REMOTE_AGENT_METHODS } from './gateway.js';
export type { A2AGatewayConfig, RemoteAgentNotice } from './gateway.js';
