package platform

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestHTTPTracePropagationAndPrivacy(t *testing.T) {
	previousProvider, previousPropagator := otel.GetTracerProvider(), otel.GetTextMapPropagator()
	defer otel.SetTracerProvider(previousProvider)
	defer otel.SetTextMapPropagator(previousPropagator)
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	defer provider.Shutdown(context.Background())
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	const secret = "sensitive-code-state-cookie-token-content"
	var serverContext trace.SpanContext
	upstream := httptest.NewServer(HTTPHandler("test", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serverContext = trace.SpanContextFromContext(r.Context())
		if r.URL.Query().Get("code") != secret || r.Header.Get("Authorization") != "Bearer "+secret {
			t.Error("request content changed")
		}
		w.WriteHeader(http.StatusPartialContent)
		_, _ = io.WriteString(w, "range")
	})))
	defer upstream.Close()
	ctx, parent := provider.Tracer("test").Start(context.Background(), "parent")
	request, _ := http.NewRequestWithContext(ctx, "GET", upstream.URL+"/auth/callback?code="+secret+"&state="+secret, nil)
	request.Header.Set("Authorization", "Bearer "+secret)
	request.Header.Set("Cookie", "session="+secret)
	client := &http.Client{Transport: SafeTransport{}}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	_ = response.Body.Close()
	parent.End()
	if response.StatusCode != 206 || string(body) != "range" {
		t.Fatal("response contract changed")
	}
	spans := recorder.Ended()
	if len(spans) != 3 {
		t.Fatalf("got %d spans", len(spans))
	}
	if serverContext.TraceID() != parent.SpanContext().TraceID() {
		t.Fatal("W3C trace context lost")
	}
	var clientID trace.SpanID
	for _, span := range spans {
		if span.Name() == "http.client" {
			clientID = span.SpanContext().SpanID()
		}
		attrs, _ := json.Marshal(span.Attributes())
		if strings.Contains(string(attrs), secret) || strings.Contains(string(attrs), "callback") {
			t.Fatal("sensitive request data exported")
		}
		if span.SpanContext().TraceID() != serverContext.TraceID() {
			t.Fatal("trace broken")
		}
	}
	for _, span := range spans {
		if span.Name() == "test.http_request" && span.Parent().SpanID() != clientID {
			t.Fatal("remote client parent lost")
		}
	}
}
