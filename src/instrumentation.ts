/**
 * OpenTelemetry. Tracing is enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set; traces are exported
 * via OTLP/HTTP to any compatible collector (Jaeger, Tempo, Honeycomb, Datadog agent, …).
 */
export async function register() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  const { registerOTel } = await import('@vercel/otel');
  registerOTel({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'leads-crm-web' });
}
