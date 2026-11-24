/**
 * OpenTelemetry bootstrap (backend §10.5). Load BEFORE the app:
 *
 *   node --import ./dist/instrumentation.js dist/main.js
 *
 * It is a no-op unless `OTEL_SDK_DISABLED=false`. Standard `OTEL_*` variables configure the
 * exporters (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES, …).
 * Traces go to OTLP HTTP; metrics too when `OTEL_METRICS_EXPORTER=otlp` (Prometheus /metrics is
 * always served by prom-client). Instrumentations: http, undici (outbound upstream calls carry
 * `traceparent`), pg, and @fastify/otel.
 */
import { register } from 'node:module';
import { hostname } from 'node:os';

export interface OtelOptions {
  env: NodeJS.ProcessEnv;
}

export function otelEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.OTEL_SDK_DISABLED === 'false' || env.OTEL_SDK_DISABLED === '0';
}

/** service.instance.id is added to OTEL_RESOURCE_ATTRIBUTES unless already set. */
export function resourceAttributes(env: NodeJS.ProcessEnv): string {
  const current = env.OTEL_RESOURCE_ATTRIBUTES ?? '';
  if (/(^|,)service\.instance\.id=/.test(current)) return current;
  const id = env.INSTANCE_ID ?? `${hostname()}-${process.pid}`;
  return [current, `service.instance.id=${id}`].filter(Boolean).join(',');
}

export async function startOtel(env: NodeJS.ProcessEnv = process.env): Promise<{ shutdown(): Promise<void> } | null> {
  if (!otelEnabled(env)) return null;
  // ESM hook so instrumentations can patch ESM imports
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  env.OTEL_RESOURCE_ATTRIBUTES = resourceAttributes(env);
  env.OTEL_SERVICE_NAME ??= 'neurouter';
  const [{ NodeSDK }, { OTLPTraceExporter }, { getNodeAutoInstrumentations }, { UndiciInstrumentation }, fastifyOtel] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/instrumentation-undici'),
    import('@fastify/otel'),
  ]);
  // only http + pg from the auto bundle; undici is pinned separately; fastify via @fastify/otel
  const auto = getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-dns': { enabled: false },
    '@opentelemetry/instrumentation-net': { enabled: false },
    '@opentelemetry/instrumentation-undici': { enabled: false },
    '@opentelemetry/instrumentation-pino': { enabled: false },
  });
  const instrumentations: unknown[] = [...auto, new UndiciInstrumentation()];
  const FastifyOtel = (fastifyOtel as { FastifyOtelInstrumentation?: new (o: object) => unknown; default?: { FastifyOtelInstrumentation?: new (o: object) => unknown } }).FastifyOtelInstrumentation ?? fastifyOtel.default?.FastifyOtelInstrumentation;
  if (FastifyOtel) instrumentations.push(new FastifyOtel({ registerOnInitialization: true }));
  const metricReaders: unknown[] = [];
  if (env.OTEL_METRICS_EXPORTER === 'otlp') {
    const [{ PeriodicExportingMetricReader }, { OTLPMetricExporter }] = await Promise.all([import('@opentelemetry/sdk-metrics'), import('@opentelemetry/exporter-metrics-otlp-http')]);
    metricReaders.push(new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }));
  }
  const sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME,
    traceExporter: new OTLPTraceExporter(),
    instrumentations: instrumentations as never,
    ...(metricReaders.length ? { metricReaders: metricReaders as never } : {}),
  });
  sdk.start();
  const shutdown = () => sdk.shutdown().catch(() => {});
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  return { shutdown };
}

// Side effect when loaded with --import (not when imported by tests).
if (process.argv[1] && !process.env.VITEST) {
  await startOtel().catch((err: unknown) => console.error('OpenTelemetry failed to start:', err));
}
