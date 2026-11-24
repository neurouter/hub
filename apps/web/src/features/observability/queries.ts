import { queryOptions } from '@tanstack/react-query';
import { api, type BreakdownDimension, type MetricsFilterQuery, type MetricsInterval } from '@neurouter/shared';
import { apiFetch } from '@/lib/api-client';

export const metricsKeys = {
  all: ['metrics'] as const,
  summary: (f: MetricsFilterQuery) => [...metricsKeys.all, 'summary', f] as const,
  series: (f: MetricsFilterQuery, interval: MetricsInterval) => [...metricsKeys.all, 'series', f, interval] as const,
  breakdown: (f: MetricsFilterQuery, d: BreakdownDimension) => [...metricsKeys.all, 'breakdown', f, d] as const,
};

export function summaryQuery(f: MetricsFilterQuery) {
  return queryOptions({ queryKey: metricsKeys.summary(f), queryFn: ({ signal }) => apiFetch(api.metrics.summary, { query: f, signal }) });
}
export function timeseriesQuery(f: MetricsFilterQuery, interval: MetricsInterval) {
  return queryOptions({ queryKey: metricsKeys.series(f, interval), queryFn: ({ signal }) => apiFetch(api.metrics.timeseries, { query: { ...f, interval }, signal }) });
}
export function breakdownQuery(f: MetricsFilterQuery, dimension: BreakdownDimension, limit = 10) {
  return queryOptions({ queryKey: [...metricsKeys.breakdown(f, dimension), limit], queryFn: ({ signal }) => apiFetch(api.metrics.breakdown, { query: { ...f, dimension, limit }, signal }) });
}
