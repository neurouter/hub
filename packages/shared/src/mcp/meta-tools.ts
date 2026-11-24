import { SLUG_REGEX } from './naming.js';

/** Meta-tools contract (backend plan §5.8). JSON Schemas are plain objects so both sides can use them as-is. */
export const SEARCH_TOOLS_NAME = 'search_tools';
export const CALL_TOOL_NAME = 'call_tool';
export const META_TOOL_NAMES = [SEARCH_TOOLS_NAME, CALL_TOOL_NAME] as const;

const slugPattern = SLUG_REGEX.source;

export const searchToolsDefinition = {
  name: SEARCH_TOOLS_NAME,
  title: 'Search available tools',
  description:
    'Find tools you are allowed to use across all connected servers. Returns the best matches with their input schemas. Call a result with call_tool.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 500, description: 'What you want to do, in natural language or keywords.' },
      limit: { type: 'integer', minimum: 1, maximum: 25, default: 8 },
      server: { type: 'string', pattern: slugPattern, description: 'Optional server slug to restrict results.' },
      includeSchemas: { type: 'boolean', default: true },
    },
    required: ['query'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      tools: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            server: { type: 'string' },
            inputSchema: { type: 'object' },
            requiresApproval: { type: 'boolean' },
            score: { type: 'number' },
          },
          required: ['name', 'description', 'server', 'requiresApproval'],
        },
      },
      totalAllowed: { type: 'integer' },
    },
    required: ['tools', 'totalAllowed'],
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
} as const;

export const callToolDefinition = {
  name: CALL_TOOL_NAME,
  title: 'Call a tool',
  description: 'Execute a tool returned by search_tools. Pass the exact name and arguments matching its inputSchema.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 3, maxLength: 128, description: 'Exact tool name, e.g. github__create_issue.' },
      arguments: { type: 'object', default: {}, description: 'Arguments for the tool, matching its inputSchema.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  annotations: { openWorldHint: true },
} as const;

export const META_TOOL_DEFINITIONS = [searchToolsDefinition, callToolDefinition] as const;

export interface SearchToolsResultItem {
  name: string;
  title?: string;
  description: string;
  server: string;
  inputSchema?: Record<string, unknown>;
  requiresApproval: boolean;
  score?: number;
}

export interface SearchToolsResult {
  tools: SearchToolsResultItem[];
  totalAllowed: number;
}
