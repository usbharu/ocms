package media

import (
	"context"
	"encoding/base64"
	"errors"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"ocms/internal/contracts"
	"ocms/internal/platform"
)

func (s *Service) encode(ctx context.Context, input any) (contracts.Embedding, error) {
	ctx, end := platform.Span(ctx, "embedding.encode")
	defer end()
	started := time.Now()
	defer platform.Duration(ctx, "media.embedding.duration", started)
	var out contracts.Embedding
	err := platform.Call(ctx, "POST", s.Runtime+"/encode", "", input, &out)
	if err != nil {
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		var httpError *platform.HTTPError
		code := "INFERENCE_UNAVAILABLE"
		status := 0
		if errors.As(err, &httpError) {
			status = httpError.Status
			code = "INFERENCE_FAILED"
			if status == 400 || status == 422 {
				code = "INVALID_INFERENCE_INPUT"
			}
		}
		trace.SpanFromContext(ctx).SetStatus(codes.Error, code)
		slog.WarnContext(ctx, "media.inference_request_failed", "error_code", code, "upstream_status", status)
		return out, processingError(code)
	}
	return out, nil
}
func (s *Service) embed(ctx context.Context, j contracts.Job) error {
	identity, err := s.inferenceIdentity(ctx)
	if err != nil {
		return err
	}
	encode := func(input any) (contracts.Embedding, error) { return s.encodeCheckpoint(ctx, j, identity, input) }
	dir, err := os.MkdirTemp("", "ocms-embedding-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	mime, err := s.sourceType(ctx, j.BlobID)
	if err != nil {
		return err
	}
	var input string
	if mime != "application/pdf" && !strings.HasPrefix(mime, "image/") {
		input, err = s.download(ctx, j, dir)
		if err != nil {
			return err
		}
	}
	index := contracts.Index{BlobID: j.BlobID}
	add := func(kind, path string, ordinal int, page *int, start, end *int64) error {
		data, e := os.ReadFile(path)
		if e != nil {
			return e
		}
		vector, e := encode(map[string]any{"kind": kind, "data": base64.StdEncoding.EncodeToString(data)})
		if e != nil {
			return e
		}
		vector.Source = kind
		if page != nil {
			vector.Source = "pdf_page"
		}
		vector.Ordinal = ordinal
		vector.Page = page
		vector.Start = start
		vector.End = end
		index.Embeddings = append(index.Embeddings, vector)
		return nil
	}
	switch {
	case strings.HasPrefix(mime, "image/"):
		path, e := s.analysisImage(ctx, j, dir, 0)
		if e != nil {
			return e
		}
		if err = add("image", path, 0, nil, nil, nil); err != nil {
			return err
		}
	case mime == "application/pdf":
		pages, e := s.pdfPages(ctx, j.BlobID)
		if e != nil {
			return e
		}
		for page := 1; page <= pages; page++ {
			path, e := s.analysisImage(ctx, j, dir, page)
			if e != nil {
				return e
			}
			p := page
			if err = add("image", path, page-1, &p, nil, nil); err != nil {
				return err
			}
			slog.InfoContext(ctx, "media.embedding_page_completed", "job_id", j.ID, "page", page, "pages", pages)
		}
	case strings.HasPrefix(mime, "video/"):
		info, e := probe(ctx, input)
		if e != nil {
			return e
		}
		duration, _ := strconv.ParseFloat(info.Format.Duration, 64)
		for offset := 0; float64(offset) < duration; offset += 30 {
			frames := []string{}
			for n := 0; n < 4; n++ {
				second := float64(offset) + float64(n)*7.5
				if second >= duration {
					break
				}
				path := filepath.Join(dir, "frame.png")
				if err = ffmpegAt(ctx, input, path, strconv.FormatFloat(second, 'f', 2, 64), "-frames:v", "1", "-vf", "scale=384:384:force_original_aspect_ratio=decrease"); err != nil {
					return err
				}
				data, e := os.ReadFile(path)
				if e != nil {
					return e
				}
				frames = append(frames, base64.StdEncoding.EncodeToString(data))
			}
			vector, e := encode(map[string]any{"kind": "video", "frames": frames})
			if e != nil {
				return e
			}
			start, end := int64(offset*1000), int64(min(float64(offset+30), duration)*1000)
			vector.Source = "video"
			vector.Ordinal = offset / 30
			vector.Start = &start
			vector.End = &end
			index.Embeddings = append(index.Embeddings, vector)
		}
	case strings.HasPrefix(mime, "audio/"):
		info, e := probe(ctx, input)
		if e != nil {
			return e
		}
		duration, _ := strconv.ParseFloat(info.Format.Duration, 64)
		for offset := 0; float64(offset) < duration; offset += 60 {
			path := filepath.Join(dir, "audio.wav")
			if err = ffmpeg(ctx, input, path, "-ss", strconv.Itoa(offset), "-t", "60", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"); err != nil {
				return err
			}
			start, end := int64(offset*1000), int64(min(float64(offset+60), duration)*1000)
			if err = add("audio", path, offset/60, nil, &start, &end); err != nil {
				return err
			}
		}
	default:
		return processingError("MEDIA_UNSUPPORTED")
	}
	var passages struct {
		Passages []contracts.Passage `json:"passages"`
	}
	if err = platform.Call(ctx, "GET", s.Search+"/internal/passages/"+j.BlobID, "", nil, &passages); err != nil {
		return err
	}
	for i, p := range passages.Passages {
		// Keep each text fragment within the model's token budget; native media vectors
		// remain present independently from OCR/ASR text representations.
		content := []rune(p.Content)
		for chunk := 0; chunk < len(content); chunk += 1000 {
			v, e := encode(map[string]any{"kind": "text", "text": string(content[chunk:min(chunk+1000, len(content))])})
			if e != nil {
				return e
			}
			v.Source = "text"
			v.Ordinal = i*10000 + chunk/1000
			v.Page = p.Page
			v.Start = p.Start
			v.End = p.End
			index.Embeddings = append(index.Embeddings, v)
		}
		slog.InfoContext(ctx, "media.embedding_text_completed", "job_id", j.ID, "passage", i+1, "passages", len(passages.Passages))
	}
	return platform.Call(ctx, "POST", s.Search+"/internal/embeddings", "", index, nil)
}
