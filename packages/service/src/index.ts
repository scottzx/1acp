/**
 * @1agents/acp-service
 *
 * DreamMate Network ACP Agent Runtime Service.
 */
export { buildManifest, ACP_CAPABILITIES, DEFAULT_ACP_PORT } from './manifest.js';
export type { AccessDescriptor, NetworkService, NodeIdentity, NodeManifest, Reachability } from './manifest.js';
export { createAcpServer, serveAcpService } from './server.js';
export type { ServerOptions } from './server.js';
export { attachBridgeServer, activeSessions, sessionBackgroundTasks, killAllManagedAgents } from './bridge.js';
