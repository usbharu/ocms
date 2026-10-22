package platform

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/felixge/httpsnoop"
	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

var counters = map[string]metric.Int64Counter{}
var histograms = map[string]metric.Float64Histogram{}

func Count(ctx context.Context, name string, n int64, attrs ...attribute.KeyValue) {
	if c := counters[name]; c != nil {
		c.Add(ctx, n, metric.WithAttributes(attrs...))
	}
}
func Observe(ctx context.Context, name string, seconds float64, attrs ...attribute.KeyValue) {
	if h := histograms[name]; h != nil {
		h.Record(ctx, seconds, metric.WithAttributes(attrs...))
	}
}
func Duration(ctx context.Context, name string, start time.Time, attrs ...attribute.KeyValue) {
	Observe(ctx, name, time.Since(start).Seconds(), attrs...)
}
func Span(ctx context.Context, name string) (context.Context, func()) {
	ctx, s := otel.Tracer("ocms").Start(ctx, name)
	return ctx, func() { s.End() }
}

type logHandler struct{ handlers []slog.Handler }

func (h logHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, x := range h.handlers {
		if x.Enabled(ctx, level) {
			return true
		}
	}
	return false
}
func (h logHandler) Handle(ctx context.Context, r slog.Record) error {
	sc := trace.SpanContextFromContext(ctx)
	if sc.IsValid() {
		r.AddAttrs(slog.String("trace_id", sc.TraceID().String()), slog.String("span_id", sc.SpanID().String()))
	}
	var err error
	for _, x := range h.handlers {
		if x.Enabled(ctx, r.Level) {
			err = errors.Join(err, x.Handle(ctx, r.Clone()))
		}
	}
	return err
}
func (h logHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	out := logHandler{}
	for _, x := range h.handlers {
		out.handlers = append(out.handlers, x.WithAttrs(attrs))
	}
	return out
}
func (h logHandler) WithGroup(group string) slog.Handler {
	out := logHandler{}
	for _, x := range h.handlers {
		out.handlers = append(out.handlers, x.WithGroup(group))
	}
	return out
}
func Telemetry(ctx context.Context, name string) (func(context.Context) error, error) {
	res := resource.NewSchemaless(attribute.String("service.name", name), attribute.String("service.version", "0.2.0"), attribute.String("deployment.environment.name", Env("DEPLOYMENT_ENVIRONMENT", "development")))
	traceOpts := []sdktrace.TracerProviderOption{sdktrace.WithResource(res)}
	metricOpts := []sdkmetric.Option{sdkmetric.WithResource(res)}
	logOpts := []sdklog.LoggerProviderOption{sdklog.WithResource(res)}
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" {
		te, err := otlptracehttp.New(ctx)
		if err != nil {
			return nil, err
		}
		traceOpts = append(traceOpts, sdktrace.WithBatcher(te, sdktrace.WithBatchTimeout(time.Second)))
		me, err := otlpmetrichttp.New(ctx)
		if err != nil {
			return nil, err
		}
		metricOpts = append(metricOpts, sdkmetric.WithReader(sdkmetric.NewPeriodicReader(me, sdkmetric.WithInterval(3*time.Second))))
		le, err := otlploghttp.New(ctx)
		if err != nil {
			return nil, err
		}
		logOpts = append(logOpts, sdklog.WithProcessor(sdklog.NewBatchProcessor(le, sdklog.WithExportInterval(time.Second))))
	}
	tp := sdktrace.NewTracerProvider(traceOpts...)
	mp := sdkmetric.NewMeterProvider(metricOpts...)
	lp := sdklog.NewLoggerProvider(logOpts...)
	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	base := slog.NewJSONHandler(os.Stdout, nil)
	slog.SetDefault(slog.New(logHandler{[]slog.Handler{base, otelslog.NewHandler(name, otelslog.WithLoggerProvider(lp))}}).With("service.name", name))
	// Exporter failures must not recursively generate OTLP logs or expose endpoint credentials.
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(error) {
		_ = base.Handle(context.Background(), slog.NewRecord(time.Now(), slog.LevelWarn, "telemetry.export_failed", 0))
	}))
	meter := mp.Meter("ocms")
	for _, n := range []string{"media.upload.bytes", "media.download.bytes", "media.dedup.hits", "media.dedup.saved_bytes", "media.job.completed", "media.crypto.bytes"} {
		c, err := meter.Int64Counter(n)
		if err != nil {
			return nil, err
		}
		counters[n] = c
	}
	for _, n := range []string{"media.upload.duration", "media.transcode.duration", "media.search.duration", "media.embedding.duration", "http.server.request.duration", "http.client.request.duration"} {
		h, err := meter.Float64Histogram(n, metric.WithUnit("s"))
		if err != nil {
			return nil, err
		}
		histograms[n] = h
	}
	return func(ctx context.Context) error {
		return errors.Join(lp.Shutdown(ctx), mp.Shutdown(ctx), tp.Shutdown(ctx))
	}, nil
}
func method(value string) string {
	switch value {
	case "GET", "POST", "PUT", "HEAD", "PATCH", "DELETE", "OPTIONS":
		return value
	default:
		return "OTHER"
	}
}

// HTTPHandler exports only an allowlist of attributes. Raw queries, URLs, request
// headers and bodies (including OIDC codes/state and search text) never reach OTLP.
func HTTPHandler(name string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		ctx, span := otel.Tracer("ocms.http").Start(ctx, name+".http_request", trace.WithSpanKind(trace.SpanKindServer), trace.WithAttributes(attribute.String("http.request.method", method(r.Method))))
		defer span.End()
		start := time.Now()
		result := httpsnoop.CaptureMetrics(next, w, r.WithContext(ctx))
		span.SetAttributes(attribute.Int("http.response.status_code", result.Code))
		if result.Code >= 500 {
			span.SetStatus(codes.Error, "HTTP server error")
		}
		Duration(ctx, "http.server.request.duration", start, attribute.String("http.request.method", method(r.Method)), attribute.Int("http.response.status_code", result.Code))
	})
}

type SafeTransport struct{ Base http.RoundTripper }

func (t SafeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	ctx, span := otel.Tracer("ocms.http").Start(r.Context(), "http.client", trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(attribute.String("http.request.method", method(r.Method)), attribute.String("server.address", r.URL.Hostname())))
	clone := r.Clone(ctx)
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(clone.Header))
	start := time.Now()
	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}
	res, err := base.RoundTrip(clone)
	if err != nil {
		span.SetStatus(codes.Error, "HTTP transport failed")
		span.End()
		Duration(ctx, "http.client.request.duration", start, attribute.String("outcome", "error"))
		return nil, err
	}
	span.SetAttributes(attribute.Int("http.response.status_code", res.StatusCode))
	if res.StatusCode >= 500 {
		span.SetStatus(codes.Error, "HTTP upstream error")
	}
	res.Body = &spanBody{ReadCloser: res.Body, finish: func() {
		Duration(ctx, "http.client.request.duration", start, attribute.String("outcome", "completed"))
		span.End()
	}}
	return res, nil
}

type spanBody struct {
	io.ReadCloser
	finish func()
}

func (b *spanBody) Close() error {
	err := b.ReadCloser.Close()
	if b.finish != nil {
		b.finish()
		b.finish = nil
	}
	return err
}
