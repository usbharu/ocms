package media

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"ocms/internal/contracts"
)

// Bump this identity whenever rendering, OCR languages/options, or indexing
// semantics change. The source Blob is immutable and each Job belongs to it.
const pdfCheckpointVersion = encoderVersion + ":pdf-page-v1:eng+jpn:psm6"

type pdfPageCheckpoint struct {
	Hash    contracts.Hash     `json:"hash"`
	Passage *contracts.Passage `json:"passage,omitempty"`
}

func (s *Service) pdfPageCheckpoints(ctx context.Context, j contracts.Job, pages int) (map[int]pdfPageResult, error) {
	var active bool
	if err := s.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM media.processing_jobs
		WHERE id=$1 AND source_blob_id=$2 AND lease_token=$3 AND status='running' AND locked_until>now())`,
		j.ID, j.BlobID, j.Lease).Scan(&active); err != nil {
		return nil, err
	}
	if !active {
		return nil, processingError("LEASE_LOST")
	}
	rows, err := s.DB.Query(ctx, `SELECT c.page,c.result FROM media.pdf_page_checkpoints c
		WHERE c.job_id=$1 AND c.pipeline_version=$2 AND c.pages=$3
		AND EXISTS(SELECT 1 FROM media.renditions r WHERE r.source_blob_id=$4
			AND r.profile_id='pdf.page-'||c.page||'-v1' AND r.encoder_version=$5 AND r.mime_type='image/png')
		AND EXISTS(SELECT 1 FROM media.renditions r WHERE r.source_blob_id=$4
			AND r.profile_id='pdf.display-'||c.page||'-v1' AND r.encoder_version=$5 AND r.mime_type='image/webp')`,
		j.ID, pdfCheckpointVersion, pages, j.BlobID, encoderVersion)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	saved := make(map[int]pdfPageResult)
	for rows.Next() {
		var page int
		var raw []byte
		if err := rows.Scan(&page, &raw); err != nil {
			return nil, err
		}
		var checkpoint pdfPageCheckpoint
		if json.Unmarshal(raw, &checkpoint) != nil || !validPDFCheckpoint(checkpoint, page, pages) {
			return nil, processingError("INVALID_PDF_CHECKPOINT")
		}
		saved[page] = pdfPageResult{hash: checkpoint.Hash, passage: checkpoint.Passage}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(saved) > 0 {
		slog.InfoContext(ctx, "media.pdf_checkpoints_reused", "job_id", j.ID, "pages_reused", len(saved), "pages", pages)
	}
	return saved, nil
}

func validPDFCheckpoint(c pdfPageCheckpoint, page, pages int) bool {
	if page < 1 || page > pages || c.Hash.Kind != "pdf_page" || c.Hash.Ordinal != page-1 || c.Hash.Page == nil || *c.Hash.Page != page {
		return false
	}
	p := c.Passage
	return p == nil || ((p.Kind == "pdf_text" || p.Kind == "ocr") && p.Ordinal == page-1 && p.Page != nil && *p.Page == page && len(p.Content) <= 2<<20)
}

func (s *Service) savePDFPageCheckpoint(ctx context.Context, j contracts.Job, page, pages int, result pdfPageResult) error {
	raw, err := json.Marshal(pdfPageCheckpoint{Hash: result.hash, Passage: result.passage})
	if err != nil {
		return err
	}
	tag, err := s.DB.Exec(ctx, `WITH active_job AS (
			SELECT id FROM media.processing_jobs WHERE id=$1 AND source_blob_id=$7
			AND lease_token=$2 AND status='running' AND locked_until>now() FOR SHARE
		)
		INSERT INTO media.pdf_page_checkpoints(job_id,pipeline_version,page,pages,result)
		SELECT id,$3,$4,$5,$6 FROM active_job
		ON CONFLICT(job_id,pipeline_version,page) DO UPDATE SET pages=EXCLUDED.pages,result=EXCLUDED.result`,
		j.ID, j.Lease, pdfCheckpointVersion, page, pages, raw, j.BlobID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return processingError("LEASE_LOST")
	}
	slog.DebugContext(ctx, "media.pdf_checkpoint_saved", "job_id", j.ID, "page", page, "pages", pages)
	return nil
}

// Render only consecutive missing pages. Completed pages on either side of a
// gap keep their stored previews, hashes and OCR passages.
func (s *Service) resumePDFBatch(ctx context.Context, j contracts.Job, input, dir string, batch []pdfPage, saved map[int]pdfPageResult) ([]pdfPageResult, error) {
	results := make([]pdfPageResult, len(batch))
	for first := 0; first < len(batch); {
		if result, ok := saved[batch[first].number]; ok {
			results[first] = result
			first++
			continue
		}
		last := first + 1
		for last < len(batch) {
			if _, ok := saved[batch[last].number]; ok {
				break
			}
			last++
		}
		images, err := renderPDFBatch(ctx, input, dir, batch[first].number, batch[last-1].number)
		if err != nil {
			return nil, err
		}
		start := first
		concurrency := s.PDFPageConcurrency
		if concurrency < 1 {
			concurrency = 2
		}
		if err := runPDFBatch(ctx, last-first, concurrency, func(ctx context.Context, i int) error {
			pos := start + i
			page := batch[pos]
			page.rendered = images[page.number]
			result, err := s.processPDFPage(ctx, j, dir, page)
			if err != nil {
				return err
			}
			if err := s.savePDFPageCheckpoint(ctx, j, page.number, page.total, result); err != nil {
				return err
			}
			slog.InfoContext(ctx, "media.pdf_page_completed", "job_id", j.ID, "page", page.number, "pages", page.total)
			results[pos] = result
			return nil
		}); err != nil {
			return nil, fmt.Errorf("PDF page batch: %w", err)
		}
		first = last
	}
	return results, nil
}
