package media

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"ocms/internal/contracts"
	"ocms/internal/platform"
)

func analysisTestService(t *testing.T) (*Service, contracts.Job) {
	t.Helper()
	connection := os.Getenv("OCMS_TEST_DATABASE_URL")
	if connection == "" {
		t.Skip("requires disposable migrated OCMS_TEST_DATABASE_URL")
	}
	db, err := pgxpool.New(context.Background(), connection)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	j := contracts.Job{ID: uuid.NewString(), BlobID: uuid.NewString(), Lease: uuid.NewString()}
	_, err = db.Exec(context.Background(), `INSERT INTO media.processing_jobs(id,event_id,source_blob_id,job_type,status,lease_token,locked_until) VALUES($1,$2,$3,'media.process','running',$4,now()+interval '1 hour')`, j.ID, uuid.NewString(), j.BlobID, j.Lease)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, err := db.Exec(context.Background(), `DELETE FROM media.renditions WHERE source_blob_id=$1;`, j.BlobID)
		if err != nil {
			t.Error(err)
		}
		_, err = db.Exec(context.Background(), `DELETE FROM media.blob_metadata WHERE blob_id=$1`, j.BlobID)
		if err != nil {
			t.Error(err)
		}
		_, err = db.Exec(context.Background(), `DELETE FROM media.processing_jobs WHERE id=$1`, j.ID)
		if err != nil {
			t.Error(err)
		}
	})
	return &Service{DB: db}, j
}

func TestAnalysisRenditionAuthorizationDatabase(t *testing.T) {
	s, j := analysisTestService(t)
	output := uuid.NewString()
	_, err := s.DB.Exec(context.Background(), `INSERT INTO media.renditions(source_blob_id,output_blob_id,profile_id,encoder_version,mime_type) VALUES($1,$2,'thumbnail-v1',$3,'image/png')`, j.BlobID, output, encoderVersion)
	if err != nil {
		t.Fatal(err)
	}
	check := func(blob, lease, rendition string, want int) {
		t.Helper()
		raw, _ := json.Marshal(map[string]string{"blob_id": blob, "lease_token": lease, "rendition_blob_id": rendition})
		req := httptest.NewRequest("POST", "/", bytes.NewReader(raw))
		req.SetPathValue("id", j.ID)
		response := httptest.NewRecorder()
		s.authorize(response, req)
		if response.Code != want {
			t.Fatalf("authorization status %d, want %d", response.Code, want)
		}
	}
	check(j.BlobID, j.Lease, "", 204)
	check(j.BlobID, j.Lease, output, 204)
	check(j.BlobID, j.Lease, uuid.NewString(), 403)
	check(uuid.NewString(), j.Lease, output, 403)
	check(j.BlobID, uuid.NewString(), output, 403)
	_, err = s.DB.Exec(context.Background(), `UPDATE media.processing_jobs SET locked_until=now()-interval '1 second' WHERE id=$1`, j.ID)
	if err != nil {
		t.Fatal(err)
	}
	check(j.BlobID, j.Lease, output, 403)
	_, err = s.DB.Exec(context.Background(), `UPDATE media.processing_jobs SET locked_until=now()+interval '1 hour',status='completed' WHERE id=$1`, j.ID)
	if err != nil {
		t.Fatal(err)
	}
	check(j.BlobID, j.Lease, output, 403)
}

// A generated PDF with text, a blank page, then text verifies page attribution.
func analysisTestPDF(texts ...string) []byte {
	if len(texts) == 0 {
		texts = []string{"FIRST PAGE", "", "THIRD PAGE"}
	}
	var kids strings.Builder
	for i := range texts {
		fmt.Fprintf(&kids, "%d 0 R ", 4+i*2)
	}
	objects := []string{"<< /Type /Catalog /Pages 2 0 R >>", fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", kids.String(), len(texts)), "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"}
	for i, text := range texts {
		objects = append(objects, fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>", 5+i*2))
		stream := fmt.Sprintf("BT /F1 24 Tf 50 300 Td (%s) Tj ET", text)
		objects = append(objects, fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(stream), stream))
	}
	var b bytes.Buffer
	b.WriteString("%PDF-1.4\n")
	offsets := []int{0}
	for i, object := range objects {
		offsets = append(offsets, b.Len())
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, object)
	}
	start := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&b, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), start)
	return b.Bytes()
}

func TestPDFThumbnailPipelineDatabase(t *testing.T) {
	for _, tool := range []string{"ffmpeg", "pdftoppm", "pdftotext", "pdfinfo", "tesseract"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip("requires media codecs and OCR")
		}
	}
	s, j := analysisTestService(t)
	t.Setenv("MEDIA_MAX_PDF_PAGES", "500")
	ctx := platform.WithJob(context.Background(), j.ID, j.Lease)
	dir := t.TempDir()
	input := filepath.Join(dir, "source.pdf")
	if err := os.WriteFile(input, analysisTestPDF(), 0600); err != nil {
		t.Fatal(err)
	}
	// Count actual subprocesses; wrappers execute the installed codecs.
	toolsDir := t.TempDir()
	logPath := filepath.Join(toolsDir, "calls")
	for _, tool := range []string{"pdftoppm", "pdftotext", "tesseract"} {
		original, _ := exec.LookPath(tool)
		script := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' '%s' >> '%s'\nexec '%s' \"$@\"\n", tool, logPath, original)
		if err := os.WriteFile(filepath.Join(toolsDir, tool), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", toolsDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	stored := map[string][]byte{}
	transfer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Job-ID") != j.ID || r.Header.Get("X-Job-Lease") != j.Lease {
			t.Error("missing Job lease")
			w.WriteHeader(403)
			return
		}
		if r.Method == "POST" {
			data, _ := io.ReadAll(r.Body)
			id := uuid.NewString()
			stored[id] = data
			platform.JSON(w, 200, map[string]string{"blob_id": id})
			return
		}
		data, ok := stored[r.URL.Query().Get("rendition")]
		if !ok {
			t.Error("unexpected original download or missing rendition")
			w.WriteHeader(404)
			return
		}
		w.Write(data)
	}))
	defer transfer.Close()
	s.Transfer = transfer.URL
	index := contracts.Index{BlobID: j.BlobID}
	metadata := map[string]any{}
	if err := s.processPDF(ctx, j, input, dir, &index, metadata); err != nil {
		t.Fatal(err)
	}
	var analysisPNG, sharedWebP int
	if err := s.DB.QueryRow(ctx, `SELECT count(*) FILTER (WHERE profile_id LIKE 'pdf.thumbnail-%'), count(*) FILTER (WHERE profile_id LIKE 'pdf.display-%' AND mime_type='image/webp') FROM media.renditions WHERE source_blob_id=$1`, j.BlobID).Scan(&analysisPNG, &sharedWebP); err != nil {
		t.Fatal(err)
	}
	if analysisPNG != 0 || sharedWebP != 3 {
		t.Fatalf("unexpected PDF thumbnail renditions: PNG=%d WebP=%d", analysisPNG, sharedWebP)
	}
	if len(index.Hashes) != 3 || len(index.Passages) != 2 || *index.Passages[0].Page != 1 || *index.Passages[1].Page != 3 || !strings.Contains(index.Passages[1].Content, "THIRD PAGE") {
		t.Fatal("page attribution or hashes lost")
	}
	if _, err := os.Stat(filepath.Join(dir, "page-3.ppm")); !os.IsNotExist(err) {
		t.Fatal("page image retained")
	}
	for page := 1; page <= 3; page++ {
		path, err := s.analysisImage(ctx, j, dir, page)
		if err != nil {
			t.Fatal(err)
		}
		info, err := probe(ctx, path)
		if err != nil || len(info.Streams) == 0 || max(info.Streams[0].Width, info.Streams[0].Height) != 512 {
			t.Fatalf("invalid analysis image: %v", err)
		}
	}
	// Downstream Jobs consume only the stored thumbnails, never the original.
	if _, err := s.DB.Exec(ctx, `INSERT INTO media.blob_metadata(blob_id,mime_type,metadata) VALUES($1,'application/pdf','{"pages":3}')`, j.BlobID); err != nil {
		t.Fatal(err)
	}
	identity := inferenceIdentity{Model: "test-model", Revision: "test-revision", DType: "float32"}
	encodes, tags := 0, 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/info"):
			platform.JSON(w, 200, map[string]string{"mime_type": "application/pdf"})
		case r.URL.Path == "/healthz":
			platform.JSON(w, 200, identity)
		case r.URL.Path == "/tag" || r.URL.Path == "/encode":
			var payload struct {
				Kind string `json:"kind"`
				Data string `json:"data"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			if payload.Kind == "image" {
				data, err := base64.StdEncoding.DecodeString(payload.Data)
				if err != nil {
					t.Error(err)
					w.WriteHeader(400)
					return
				}
				if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" || len(data) >= 80000 {
					t.Error("inference did not receive a compact WebP")
					w.WriteHeader(400)
					return
				}
			}
			if r.URL.Path == "/tag" {
				tags++
				platform.JSON(w, 200, contracts.TagResult{Model: contracts.TagModel, Revision: contracts.TagRevision, Characters: []contracts.TagScore{}, Rating: "general"})
			} else {
				encodes++
				vector := make([]float64, 768)
				vector[0] = 1
				platform.JSON(w, 200, contracts.Embedding{Model: identity.Model, Revision: identity.Revision, Vector: vector})
			}
		case strings.HasPrefix(r.URL.Path, "/internal/passages/"):
			platform.JSON(w, 200, map[string]any{"passages": index.Passages})
		case r.URL.Path == "/internal/embeddings":
			var result contracts.Index
			if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
				t.Error(err)
			}
			if len(result.Embeddings) != 5 || result.Embeddings[2].Page == nil || *result.Embeddings[2].Page != 3 {
				t.Error("embedding page attribution lost")
			}
			w.WriteHeader(204)
		case strings.HasSuffix(r.URL.Path, "/tags"):
			w.WriteHeader(204)
		default:
			t.Error("unexpected API request")
			w.WriteHeader(404)
		}
	}))
	defer api.Close()
	s.Catalog, s.Runtime, s.Search = api.URL, api.URL, api.URL
	if err := s.tag(ctx, j); err != nil {
		t.Fatal(err)
	}
	if err := s.embed(ctx, j); err != nil {
		t.Fatal(err)
	}
	if err := s.embed(ctx, j); err != nil {
		t.Fatal(err)
	}
	if encodes != 5 || tags != 3 {
		t.Fatalf("inference or checkpoint reuse incorrect: encodes=%d tags=%d", encodes, tags)
	}
	// Legacy PDFs use existing previews and never rerender the PDF.
	if _, err := s.DB.Exec(ctx, `DELETE FROM media.renditions WHERE source_blob_id=$1 AND profile_id LIKE 'pdf.display-%'`, j.BlobID); err != nil {
		t.Fatal(err)
	}
	path, err := s.analysisImage(ctx, j, dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	width, height, err := imageDimensions(path)
	if err != nil || max(width, height) != 512 {
		t.Fatal("legacy preview not resized")
	}
	if _, err = s.analysisImage(ctx, j, dir, 4); errorCode(err) != "SOURCE_UNAVAILABLE" {
		t.Fatal("missing page accepted")
	}
	calls, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(calls), "pdftotext\n") != 1 || strings.Count(string(calls), "pdftoppm\n") != 2 || strings.Count(string(calls), "tesseract\n") != 1 {
		t.Fatalf("unexpected subprocess counts: %s", calls)
	}
}

func TestImageThumbnailJobsDatabase(t *testing.T) {
	s, j := analysisTestService(t)
	ctx := platform.WithJob(context.Background(), j.ID, j.Lease)
	blob := uuid.NewString()
	_, err := s.DB.Exec(ctx, `INSERT INTO media.renditions(source_blob_id,output_blob_id,profile_id,encoder_version,mime_type) VALUES($1,$2,'thumbnail-v1',$3,'image/png')`, j.BlobID, blob, encoderVersion)
	if err != nil {
		t.Fatal(err)
	}
	var thumbnail bytes.Buffer
	if err := png.Encode(&thumbnail, image.NewRGBA(image.Rect(0, 0, 32, 16))); err != nil {
		t.Fatal(err)
	}
	identity := inferenceIdentity{Model: "test-model", Revision: "test-revision", DType: "float32"}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/info"):
			platform.JSON(w, 200, map[string]string{"mime_type": "image/png"})
		case strings.HasSuffix(r.URL.Path, "/content"):
			if r.URL.Query().Get("rendition") != blob || r.Header.Get("X-Job-ID") != j.ID || r.Header.Get("X-Job-Lease") != j.Lease {
				t.Error("original image or wrong lease requested")
				w.WriteHeader(403)
				return
			}
			w.Write(thumbnail.Bytes())
		case r.URL.Path == "/healthz":
			platform.JSON(w, 200, identity)
		case r.URL.Path == "/tag" || r.URL.Path == "/encode":
			var payload struct {
				Data string `json:"data"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Error(err)
			}
			data, _ := base64.StdEncoding.DecodeString(payload.Data)
			if !bytes.Equal(data, thumbnail.Bytes()) {
				t.Error("stored thumbnail was not reused verbatim")
			}
			if r.URL.Path == "/tag" {
				platform.JSON(w, 200, contracts.TagResult{Model: contracts.TagModel, Revision: contracts.TagRevision, Characters: []contracts.TagScore{}, Rating: "general"})
			} else {
				vector := make([]float64, 768)
				vector[0] = 1
				platform.JSON(w, 200, contracts.Embedding{Model: identity.Model, Revision: identity.Revision, Vector: vector})
			}
		case strings.HasPrefix(r.URL.Path, "/internal/passages/"):
			platform.JSON(w, 200, map[string]any{"passages": []contracts.Passage{}})
		case strings.HasSuffix(r.URL.Path, "/tags"), r.URL.Path == "/internal/embeddings":
			w.WriteHeader(204)
		default:
			t.Error("unexpected API request")
			w.WriteHeader(404)
		}
	}))
	defer api.Close()
	s.Transfer, s.Catalog, s.Runtime, s.Search = api.URL, api.URL, api.URL, api.URL
	// These Jobs must work even without ffmpeg or the original image.
	t.Setenv("PATH", t.TempDir())
	if err := s.tag(ctx, j); err != nil {
		t.Fatal(err)
	}
	if err := s.embed(ctx, j); err != nil {
		t.Fatal(err)
	}
	for _, pages := range []int{0, 501} {
		_, err := s.DB.Exec(ctx, `INSERT INTO media.blob_metadata(blob_id,metadata) VALUES($1,jsonb_build_object('pages',$2::int)) ON CONFLICT(blob_id) DO UPDATE SET metadata=excluded.metadata`, j.BlobID, pages)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.pdfPages(ctx, j.BlobID); errorCode(err) != "PDF_PAGE_LIMIT" {
			t.Fatal("invalid PDF page count accepted")
		}
	}
}

func TestPDFRenderBatches(t *testing.T) {
	if _, err := exec.LookPath("pdftoppm"); err != nil {
		t.Skip("requires Poppler")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "source.pdf")
	if err := os.WriteFile(input, analysisTestPDF(make([]string, 12)...), 0600); err != nil {
		t.Fatal(err)
	}
	for _, interval := range [][2]int{{1, 1}, {2, 9}, {10, 12}} {
		images, err := renderPDFBatch(context.Background(), input, dir, interval[0], interval[1])
		if err != nil {
			t.Fatal(err)
		}
		if len(images) != interval[1]-interval[0]+1 || len(images) > 8 {
			t.Fatal("batch size not bounded")
		}
		for page := interval[0]; page <= interval[1]; page++ {
			path := images[page]
			file, err := os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			var magic string
			var width, height, maxValue int
			_, err = fmt.Fscan(file, &magic, &width, &height, &maxValue)
			file.Close()
			if err != nil || magic != "P6" || maxValue != 255 || max(width, height) != 1600 {
				t.Fatalf("page %d missing or wrong size", page)
			}
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestAnalysisResizePreservesPixels(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("requires FFmpeg")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "source.png")
	f, err := os.Create(source)
	if err != nil {
		t.Fatal(err)
	}
	img := image.NewNRGBA(image.Rect(0, 0, 800, 400))
	for y := 0; y < 400; y++ {
		for x := 0; x < 800; x++ {
			i := img.PixOffset(x, y)
			img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = byte(x), byte(y), byte(x+y), byte((x+y)%256)
		}
	}
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	oldPath, newPath := filepath.Join(dir, "old.png"), filepath.Join(dir, "new.png")
	ctx := context.Background()
	if err := ffmpeg(ctx, source, oldPath, "-frames:v", "1", "-vf", "scale=512:512:force_original_aspect_ratio=decrease"); err != nil {
		t.Fatal(err)
	}
	if err := resizeAnalysisImage(ctx, source, newPath); err != nil {
		t.Fatal(err)
	}
	decode := func(path string) image.Image {
		t.Helper()
		f, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		img, err := png.Decode(f)
		if err != nil {
			t.Fatal(err)
		}
		return img
	}
	old, resized := decode(oldPath), decode(newPath)
	if old.Bounds() != resized.Bounds() || max(resized.Bounds().Dx(), resized.Bounds().Dy()) != 512 {
		t.Fatal("thumbnail dimensions changed")
	}
	for y := old.Bounds().Min.Y; y < old.Bounds().Max.Y; y++ {
		for x := old.Bounds().Min.X; x < old.Bounds().Max.X; x++ {
			if old.At(x, y) != resized.At(x, y) {
				t.Fatalf("thumbnail pixel differs at %d,%d", x, y)
			}
		}
	}
}

func TestDisplayThumbnailWebP(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("requires FFmpeg")
	}
	dir := t.TempDir()
	input, output := filepath.Join(dir, "input.png"), filepath.Join(dir, "display.webp")
	img := image.NewNRGBA(image.Rect(0, 0, 512, 512))
	var state uint32 = 1
	for i := 0; i < len(img.Pix); i++ {
		state = state*1664525 + 1013904223
		img.Pix[i] = byte(state >> 24)
	}
	file, err := os.Create(input)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(file, img); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := previewAndThumbnail(context.Background(), input, filepath.Join(dir, "preview.png"), output, true); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		t.Fatalf("invalid WebP: %d bytes", len(data))
	}
	if len(data) < 80000 {
		t.Fatal("test image did not exercise the size target overflow")
	}
	info, err := probe(context.Background(), output)
	if err != nil || len(info.Streams) == 0 || info.Streams[0].Width != 512 || info.Streams[0].Height != 512 {
		t.Fatalf("resolution changed: %v", err)
	}
}

func TestCombinedPDFOutputMatchesPreviousPixels(t *testing.T) {
	for _, tool := range []string{"pdftoppm", "ffmpeg"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip("requires Poppler and FFmpeg")
		}
	}
	dir := t.TempDir()
	pdf := filepath.Join(dir, "input.pdf")
	if err := os.WriteFile(pdf, analysisTestPDF("PDF page"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	oldPrefix := filepath.Join(dir, "old")
	if _, err := command(ctx, "pdftoppm", "-f", "1", "-l", "1", "-scale-to", "1600", "-png", "-singlefile", pdf, oldPrefix); err != nil {
		t.Fatal(err)
	}
	oldImage, oldWebP := oldPrefix+".png", oldPrefix+".webp"
	if err := ffmpeg(ctx, oldImage, oldWebP, "-frames:v", "1", "-vf", "scale=512:512:force_original_aspect_ratio=decrease", "-c:v", "libwebp", "-quality", "75"); err != nil {
		t.Fatal(err)
	}
	batch, err := renderPDFBatch(ctx, pdf, dir, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	preview, thumbnail := filepath.Join(dir, "new.png"), filepath.Join(dir, "new.webp")
	if err := previewAndThumbnail(ctx, batch[1], preview, thumbnail, false); err != nil {
		t.Fatal(err)
	}
	decode := func(path string) image.Image {
		t.Helper()
		f, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		img, err := png.Decode(f)
		if err != nil {
			t.Fatal(err)
		}
		return img
	}
	old, newImage := decode(oldImage), decode(preview)
	if old.Bounds() != newImage.Bounds() {
		t.Fatal("preview dimensions changed")
	}
	for y := old.Bounds().Min.Y; y < old.Bounds().Max.Y; y++ {
		for x := old.Bounds().Min.X; x < old.Bounds().Max.X; x++ {
			r1, g1, b1, a1 := old.At(x, y).RGBA()
			r2, g2, b2, a2 := newImage.At(x, y).RGBA()
			if r1 != r2 || g1 != g2 || b1 != b2 || a1 != a2 {
				t.Fatalf("preview pixels differ at %d,%d", x, y)
			}
		}
	}
	oldBytes, err := os.ReadFile(oldWebP)
	if err != nil {
		t.Fatal(err)
	}
	newBytes, err := os.ReadFile(thumbnail)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(oldBytes, newBytes) {
		t.Fatal("thumbnail changed")
	}
}

func TestCombinedImageOutputMatchesPrevious(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("requires FFmpeg")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "input.png")
	img := image.NewNRGBA(image.Rect(0, 0, 800, 400))
	for i := 0; i < len(img.Pix); i++ {
		img.Pix[i] = byte((i*37 + i/11) % 256)
	}
	f, err := os.Create(input)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	oldPNG, oldWebP := filepath.Join(dir, "old.png"), filepath.Join(dir, "old.webp")
	newPNG, newWebP := filepath.Join(dir, "new.png"), filepath.Join(dir, "new.webp")
	if err := resizeAnalysisImage(ctx, input, oldPNG); err != nil {
		t.Fatal(err)
	}
	if err := ffmpeg(ctx, oldPNG, oldWebP, "-frames:v", "1", "-vf", "scale=512:512:force_original_aspect_ratio=decrease", "-c:v", "libwebp", "-quality", "75"); err != nil {
		t.Fatal(err)
	}
	if err := finishThumbnail(ctx, oldPNG, oldWebP); err != nil {
		t.Fatal(err)
	}
	if err := previewAndThumbnail(ctx, input, newPNG, newWebP, true); err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]string{{oldPNG, newPNG}, {oldWebP, newWebP}} {
		old, err := os.ReadFile(pair[0])
		if err != nil {
			t.Fatal(err)
		}
		updated, err := os.ReadFile(pair[1])
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(old, updated) {
			t.Fatalf("output changed: %s", filepath.Ext(pair[0]))
		}
	}
}
