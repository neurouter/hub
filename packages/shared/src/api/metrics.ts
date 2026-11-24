import * as z from 'zod';
import { Id, IsoDateTime, IsoDateTimeInput, queryOptional } from './common.js';
import { endpoint } from './endpoint.js';

const Latency = z.object({ p50: z.number().nullable(), p95: z.number().nullable(), p99: z.number().nullable() });

const SummaryCore = z.object({
  calls: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1).nullable(),
  errorRate: z.number().min(0).max(1).nullable(),
  blocked: z.number().int().nonnegative(),
  latency: Latency,
});

export const MetricsSummary = SummaryCore.extend({ previous: SummaryCore });
export type MetricsSummary = z.infer<typeof MetricsSummary>;

export const MetricsInterval = z.enum(['1m', '5m', '15m', '1h', '6h', '1d']);
export type MetricsInterval = z.infer<typeof MetricsInterval>;

export const MetricsFilterQuery = z.object({
  from: IsoDateTimeInput,
  to: IsoDateTimeInput,
  serverId: queryOptional(Id),
  toolId: queryOptional(Id),
  agentId: queryOptional(Id),
  userId: queryOptional(Id),
  scope: queryOptional(z.literal('me')),
});
export type MetricsFilterQuery = z.infer<typeof MetricsFilterQuery>;

export const TimeseriesQuery = MetricsFilterQuery.extend({ interval: MetricsInterval });
export type TimeseriesQuery = z.infer<typeof TimeseriesQuery>;

export const Timeseries = z.object({
  interval: MetricsInterval,
  points: z.array(
    z.object({
      t: IsoDateTime,
      calls: z.number().int().nonnegative(),
      success: z.number().int().nonnegative(),
      errors: z.number().int().nonnegative(),
      blocked: z.number().int().nonnegative(),
      p50: z.number().nullable(),
      p95: z.number().nullable(),
      p99: z.number().nullable(),
    }),
  ),
});
export type Timeseries = z.infer<typeof Timeseries>;

export const BreakdownDimension = z.enum(['server', 'tool', 'agent', 'user', 'block_reason']);
export type BreakdownDimension = z.infer<typeof BreakdownDimension>;
export const BreakdownSort = z.enum(['calls', 'errorRate', 'p95', 'blocked']);

export const BreakdownQuery = MetricsFilterQuery.extend({
  dimension: BreakdownDimension,
  sort: queryOptional(BreakdownSort),
  limit: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(100).optional()),
});
export type BreakdownQuery = z.infer<typeof BreakdownQuery>;

export const Breakdown = z.object({
  rows: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      calls: z.number().int().nonnegative(),
      successRate: z.number().min(0).max(1).nullable(),
      errorRate: z.number().min(0).max(1).nullable(),
      p95: z.number().nullable(),
      blocked: z.number().int().nonnegative(),
    }),
  ),
});
export type Breakdown = z.infer<typeof Breakdown>;

export const metricsEndpoints = {
  summary: endpoint({
    method: 'GET', path: '/api/metrics/summary', kind: 'json', access: ['auditor', 'owner', 'user'],
    summary: 'KPIs with the previous window', query: MetricsFilterQuery, response: MetricsSummary,
  }),
  timeseries: endpoint({
    method: 'GET', path: '/api/metrics/timeseries', kind: 'json', access: ['auditor', 'owner', 'user'],
    summary: 'Chart points', query: TimeseriesQuery, response: Timeseries,
  }),
  breakdown: endpoint({
    method: 'GET', path: '/api/metrics/breakdown', kind: 'json', access: ['auditor', 'owner', 'user'],
    summary: 'Top-N by dimension', query: BreakdownQuery, response: Breakdown,
  }),
} as const;

