package media

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"ocms/internal/contracts"
)

func TestPDFCheckpointLeaseDatabase(t *testing.T) {
	s, j := analysisTestService(t)
	ctx := context.Background()
	page := 2
	result := pdfPageResult{hash: contracts.Hash{Kind: "pdf_page", Ordinal: 1, Page: &page, Hash: "0"}}
	if err := s.savePDFPageCheckpoint(ctx, j, page, 3, result); err != nil {
		t.Fatal(err)
	}

	for _, rendition := range []struct{ profile, mime string }{
		{"pdf.page-2-v1", "image/png"},
		{"pdf.display-2-v1", "image/webp"},
	} {
		if _, err := s.DB.Exec(ctx, `INSERT INTO media.renditions(source_blob_id,output_blob_id,profile_id,encoder_version,mime_type) VALUES($1,$2,$3,$4,$5)`,
			j.BlobID, uuid.NewString(), rendition.profile, encoderVersion, rendition.mime); err != nil {
			t.Fatal(err)
		}
	}
	cache, err := s.pdfPageCheckpoints(ctx, j, 3)
	if err != nil || len(cache) != 1 {
		t.Fatalf("valid checkpoint not reused: %v", err)
	}
	cache, err = s.pdfPageCheckpoints(ctx, j, 4)
	if err != nil || len(cache) != 0 {
		t.Fatal("page count mismatch reused a checkpoint")
	}
	if _, err := s.DB.Exec(ctx, `UPDATE media.pdf_page_checkpoints SET pipeline_version='old-pipeline' WHERE job_id=$1`, j.ID); err != nil {
		t.Fatal(err)
	}
	cache, err = s.pdfPageCheckpoints(ctx, j, 3)
	if err != nil || len(cache) != 0 {
		t.Fatal("old pipeline checkpoint reused")
	}
	if _, err := s.DB.Exec(ctx, `UPDATE media.pdf_page_checkpoints SET pipeline_version=$2 WHERE job_id=$1`, j.ID, pdfCheckpointVersion); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(ctx, `DELETE FROM media.renditions WHERE source_blob_id=$1 AND mime_type='image/webp'`, j.BlobID); err != nil {
		t.Fatal(err)
	}
	cache, err = s.pdfPageCheckpoints(ctx, j, 3)
	if err != nil || len(cache) != 0 {
		t.Fatal("checkpoint with a missing rendition reused")
	}
	stale := j
	stale.Lease = "00000000-0000-0000-0000-000000000000"
	if err := s.savePDFPageCheckpoint(ctx, stale, page, 3, result); errorCode(err) != "LEASE_LOST" {
		t.Fatal("stale lease wrote a page checkpoint")
	}
	if _, err := s.pdfPageCheckpoints(ctx, stale, 3); errorCode(err) != "LEASE_LOST" {
		t.Fatal("stale lease read page checkpoints")
	}
	if _, err := s.DB.Exec(ctx, `UPDATE media.processing_jobs SET locked_until=now()-interval '1 second' WHERE id=$1`, j.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.savePDFPageCheckpoint(ctx, j, page, 3, result); errorCode(err) != "LEASE_LOST" {
		t.Fatal("expired lease wrote a page checkpoint")
	}
}
