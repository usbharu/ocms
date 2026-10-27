package media

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"

	"github.com/jackc/pgx/v5"
	"ocms/internal/contracts"
)

func resizeAnalysisImage(ctx context.Context, input, output string) error {
	return ffmpeg(ctx, input, output, "-frames:v", "1", "-vf", "scale=512:512:force_original_aspect_ratio=decrease", "-compression_level", "1")
}

// Encode both outputs from one decoded frame, then retry the WebP only if needed.
func previewAndThumbnail(ctx context.Context, input, preview, output string, previewIsThumbnail bool) error {
	filter := "[0:v]split=2[p][t];[t]scale=512:512:force_original_aspect_ratio=decrease[w]"
	compression := "6"
	if previewIsThumbnail {
		compression = "1"
		filter = "[0:v]scale=512:512:force_original_aspect_ratio=decrease,split=2[p][w]"
	}
	if err := ffmpeg(ctx, input, output, "-filter_complex_threads", "1", "-filter_complex", filter,
		"-map", "[p]", "-frames:v", "1", "-compression_level", compression, "-threads", "1", preview,
		"-map", "[w]", "-frames:v", "1", "-c:v", "libwebp", "-quality", "75"); err != nil {
		return err
	}
	return finishThumbnail(ctx, preview, output)
}

func finishThumbnail(ctx context.Context, input, output string) error {
	for _, quality := range []int{50, 35} {
		info, err := os.Stat(output)
		if err != nil {
			return err
		}
		if info.Size() < 80000 {
			return nil
		}
		if err := ffmpeg(ctx, input, output, "-frames:v", "1", "-vf", "scale=512:512:force_original_aspect_ratio=decrease", "-c:v", "libwebp", "-quality", strconv.Itoa(quality)); err != nil {
			return err
		}
	}
	return nil
}

// Resolve only stored outputs of this source. Transfer independently verifies
// the source Job, live lease and rendition relationship before decrypting.
func (s *Service) analysisImage(ctx context.Context, j contracts.Job, dir string, page int) (string, error) {
	profile, legacy, fallback := "thumbnail.display-v1", "thumbnail-v1", "thumbnail-v1"
	if page > 0 {
		profile = fmt.Sprintf("pdf.display-%d-v1", page)
		legacy = fmt.Sprintf("pdf.thumbnail-%d-v1", page)
		fallback = fmt.Sprintf("pdf.page-%d-v1", page)
	}
	var blob, selected string
	err := s.DB.QueryRow(ctx, `SELECT output_blob_id,profile_id FROM media.renditions WHERE source_blob_id=$1 AND profile_id IN ($2,$3,$4) ORDER BY CASE profile_id WHEN $2 THEN 0 WHEN $3 THEN 1 ELSE 2 END,created_at DESC LIMIT 1`, j.BlobID, profile, legacy, fallback).Scan(&blob, &selected)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", processingError("SOURCE_UNAVAILABLE")
	}
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "analysis.png")
	// At most one page is retained, including when reading old 1600px previews.
	if err = os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	path, err = downloadFile(ctx, s.Transfer+"/internal/blobs/"+j.BlobID+"/content?rendition="+url.QueryEscape(blob), path)
	if err != nil {
		return "", err
	}
	if page > 0 && selected == fallback {
		resized := filepath.Join(dir, "resized.png")
		if err = resizeAnalysisImage(ctx, path, resized); err != nil {
			return "", err
		}
		if err = os.Rename(resized, path); err != nil {
			return "", err
		}
	}
	return path, nil
}

func (s *Service) pdfPages(ctx context.Context, blob string) (int, error) {
	var metadata struct {
		Pages int `json:"pages"`
	}
	if err := s.DB.QueryRow(ctx, `SELECT metadata FROM media.blob_metadata WHERE blob_id=$1`, blob).Scan(&metadata); err != nil {
		return 0, err
	}
	if metadata.Pages < 1 || metadata.Pages > pdfPageLimit() {
		return 0, processingError("PDF_PAGE_LIMIT")
	}
	return metadata.Pages, nil
}
