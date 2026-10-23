package media

import (
	"context"
	"encoding/base64"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"ocms/internal/contracts"
	"ocms/internal/platform"
)

func taggable(mime string) bool {
	return strings.HasPrefix(mime, "image/") || strings.HasPrefix(mime, "video/") || mime == "application/pdf"
}

// Sample across the whole video, including the second half of long clips.
func tagFrameTimes(duration float64) []float64 {
	count := min(12, max(1, int(math.Ceil(duration/5))))
	times := make([]float64, count)
	for i := range times {
		times[i] = float64(i) * duration / float64(count)
	}
	return times
}

func mergeTags(scores map[string]float64, result contracts.TagResult) error {
	if result.Model != contracts.TagModel || result.Revision != contracts.TagRevision || len(result.Tags) > 256 {
		return processingError("INVALID_TAG_RESULT")
	}
	for _, tag := range result.Tags {
		if strings.TrimSpace(tag.Name) == "" || len(tag.Name) > 256 || math.IsNaN(tag.Score) || math.IsInf(tag.Score, 0) || tag.Score < 0.35 || tag.Score > 1 {
			return processingError("INVALID_TAG_RESULT")
		}
		scores[tag.Name] = max(scores[tag.Name], tag.Score)
	}
	return nil
}

func sortedTags(scores map[string]float64) []string {
	names := make([]string, 0, len(scores))
	for name := range scores {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		if scores[names[i]] == scores[names[j]] {
			return names[i] < names[j]
		}
		return scores[names[i]] > scores[names[j]]
	})
	return names[:min(256, len(names))]
}

func (s *Service) tag(ctx context.Context, j contracts.Job) error {
	ctx, end := platform.Span(ctx, "media.tag")
	defer end()
	mime, err := s.sourceType(ctx, j.BlobID)
	if err != nil {
		return err
	}
	if !taggable(mime) {
		return processingError("MEDIA_UNSUPPORTED")
	}
	dir, err := os.MkdirTemp("", "ocms-tags-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	input, err := s.download(ctx, j, dir)
	if err != nil {
		return err
	}
	scores := map[string]float64{}
	infer := func(path string) error {
		data, e := os.ReadFile(path)
		if e != nil {
			return e
		}
		var result contracts.TagResult
		if e = platform.Call(ctx, "POST", s.Runtime+"/tag", "", map[string]string{"kind": "image", "data": base64.StdEncoding.EncodeToString(data)}, &result); e != nil {
			return processingError("TAGGING_FAILED")
		}
		return mergeTags(scores, result)
	}
	frame := filepath.Join(dir, "frame.png")
	switch {
	case mime == "application/pdf":
		var metadata struct {
			Pages int `json:"pages"`
		}
		if err = s.DB.QueryRow(ctx, `SELECT metadata FROM media.blob_metadata WHERE blob_id=$1`, j.BlobID).Scan(&metadata); err != nil {
			return err
		}
		if metadata.Pages < 1 || metadata.Pages > pdfPageLimit() {
			return processingError("PDF_PAGE_LIMIT")
		}
		for p := 1; p <= metadata.Pages; p++ {
			_, err = command(ctx, "pdftoppm", "-f", strconv.Itoa(p), "-l", strconv.Itoa(p), "-singlefile", "-scale-to", "512", "-png", input, filepath.Join(dir, "frame"))
			if err != nil {
				return err
			}
			if err = infer(frame); err != nil {
				return err
			}
		}
	case strings.HasPrefix(mime, "video/"):
		info, e := probe(ctx, input)
		if e != nil {
			return e
		}
		duration, e := strconv.ParseFloat(info.Format.Duration, 64)
		if e != nil || math.IsNaN(duration) || math.IsInf(duration, 0) || duration <= 0 || duration > 600 {
			return processingError("MEDIA_DURATION_EXCEEDED")
		}
		for _, second := range tagFrameTimes(duration) {
			if err = ffmpeg(ctx, input, frame, "-ss", strconv.FormatFloat(second, 'f', 3, 64), "-frames:v", "1", "-vf", "scale=512:512:force_original_aspect_ratio=decrease"); err != nil {
				return err
			}
			if err = infer(frame); err != nil {
				return err
			}
		}
	default:
		if err = ffmpeg(ctx, input, frame, "-frames:v", "1", "-vf", "scale=512:512:force_original_aspect_ratio=decrease"); err != nil {
			return err
		}
		if err = infer(frame); err != nil {
			return err
		}
	}
	return platform.Call(ctx, "POST", s.Catalog+"/internal/blobs/"+j.BlobID+"/tags", "", map[string]any{"tags": sortedTags(scores), "model_id": contracts.TagModel, "model_revision": contracts.TagRevision}, nil)
}
