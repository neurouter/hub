export const PRODUCT_NAME = 'Neurouter';
export const API_VERSION = 'v1';
export const API_BASE_PATH = '/api';
/** MCP protocol versions the gateway serves (modern first). */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25'] as const;
export type SupportedProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];
