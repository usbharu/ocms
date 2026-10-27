package media

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	_ "image/png"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"ocms/internal/contracts"
	"ocms/internal/platform"
)

const encoderVersion = "ffmpeg-pipeline-v1"
const maxWorkBytes = int64(256 << 20)

func validProfile(mime, profile string) bool {
	if profile == "thumbnail-v1" {
		return strings.HasPrefix(mime, "image/") || strings.HasPrefix(mime, "video/")
	}
	return strings.HasPrefix(mime, "image/") && profile == "image.webp-v1" || strings.HasPrefix(mime, "video/") && profile == "video.mp4-v1" || strings.HasPrefix(mime, "audio/") && profile == "audio.opus-v1" || mime == "application/pdf" && profile == "pdf.page-1-v1"
}

// Capped subprocess output avoids retaining attacker-controlled diagnostics.
type cappedOutput struct{ bytes.Buffer }

func (b *cappedOutput) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len() < 2<<20 {
		_, _ = b.Buffer.Write(p[:min(n, (2<<20)-b.Len())])
	}
	return n, nil
}
func command(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), "OMP_NUM_THREADS=1")
	var out, diagnostic cappedOutput
	cmd.Stdout = &out
	cmd.Stderr = &diagnostic
	if err := cmd.Run(); err != nil {
		reason := toolFailure(ctx, diagnostic.String())
		exitCode := -1
		if cmd.ProcessState != nil {
			exitCode = cmd.ProcessState.ExitCode()
		}
		// Never export tool stderr: it can contain document text or filenames.
		slog.WarnContext(ctx, "media.tool_failed", "tool", filepath.Base(name), "exit_code", exitCode, "error_code", errorCode(reason))
		return nil, reason
	}
	return out.Bytes(), nil
}
func ffmpeg(ctx context.Context, input, output string, args ...string) error {
	return ffmpegAt(ctx, input, output, "", args...)
}

func ffmpegAt(ctx context.Context, input, output, seek string, args ...string) error {
	ctx, end := platform.Span(ctx, "media.transcode")
	defer end()
	started := time.Now()
	defer platform.Duration(ctx, "media.transcode.duration", started)
	common := []string{"-v", "error", "-nostdin", "-y", "-threads", "1", "-filter_threads", "1", "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe"}
	if seek != "" {
		common = append(common, "-ss", seek)
	}
	common = append(common, "-i", input)
	_, err := command(ctx, "ffmpeg", append(append(common, args...), "-threads", "1", output)...)
	return err
}
func (s *Service) download(ctx context.Context, j contracts.Job, dir string) (string, error) {
	return downloadFile(ctx, s.Transfer+"/internal/blobs/"+j.BlobID+"/content", filepath.Join(dir, "source"))
}

func downloadFile(ctx context.Context, url, file string) (string, error) {
	req, err := platform.Request(ctx, "GET", url, nil)
	if err != nil {
		return "", err
	}
	res, err := platform.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", processingError("SOURCE_UNAVAILABLE")
	}
	out, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", err
	}
	n, err := io.Copy(out, io.LimitReader(res.Body, maxWorkBytes+1))
	closeErr := out.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if n > maxWorkBytes {
		return "", processingError("MEDIA_TOO_LARGE")
	}
	return file, nil
}
func (s *Service) sourceType(ctx context.Context, blob string) (string, error) {
	var out struct {
		MIME string `json:"mime_type"`
	}
	err := platform.Call(ctx, "GET", s.Catalog+"/internal/blobs/"+blob+"/info", "", nil, &out)
	return out.MIME, err
}
func (s *Service) storeOutput(ctx context.Context, j contracts.Job, path, profile, mime string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return err
	}
	if stat.Size() > maxWorkBytes {
		return processingError("OUTPUT_TOO_LARGE")
	}
	req, err := platform.Request(ctx, "POST", s.Transfer+"/internal/blobs/"+j.BlobID+"/derivatives?profile="+profile, file)
	if err != nil {
		return err
	}
	req.ContentLength = stat.Size()
	req.Header.Set("X-Size-Bytes", strconv.FormatInt(stat.Size(), 10))
	res, err := platform.Client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return processingError("DERIVATIVE_STORE_FAILED")
	}
	var out struct {
		ID string `json:"blob_id"`
	}
	if err = json.NewDecoder(res.Body).Decode(&out); err != nil {
		return err
	}
	tag, err := s.DB.Exec(ctx, `INSERT INTO media.renditions(source_blob_id,output_blob_id,profile_id,encoder_version,mime_type) SELECT source_blob_id,$3,$4,$5,$6 FROM media.processing_jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND locked_until>now() ON CONFLICT(source_blob_id,profile_id,profile_version,encoder_version) DO NOTHING`, j.ID, j.Lease, out.ID, profile, encoderVersion, mime)
	if err == nil && tag.RowsAffected() == 0 {
		var exists bool
		err = s.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM media.renditions WHERE source_blob_id=$1 AND profile_id=$2 AND encoder_version=$3)`, j.BlobID, profile, encoderVersion).Scan(&exists)
		if err == nil && !exists {
			return processingError("LEASE_LOST")
		}
	}
	return err
}

type probeResult struct {
	Streams []struct {
		Type   string `json:"codec_type"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

func probe(ctx context.Context, path string) (probeResult, error) {
	var info probeResult
	raw, err := command(ctx, "ffprobe", "-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,ogg,wav,mp3,flac,image2,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,tiff_pipe,gif", "-show_streams", "-show_format", "-of", "json", path)
	if err != nil {
		return info, err
	}
	if json.Unmarshal(raw, &info) != nil || len(info.Streams) == 0 {
		return info, processingError("MEDIA_UNSUPPORTED")
	}
	for _, stream := range info.Streams {
		if int64(stream.Width)*int64(stream.Height) > 16777216 {
			return info, processingError("MEDIA_DIMENSIONS_EXCEEDED")
		}
	}
	duration, _ := strconv.ParseFloat(info.Format.Duration, 64)
	if duration > 1800 {
		return info, processingError("MEDIA_DURATION_EXCEEDED")
	}
	return info, nil
}
func (s *Service) process(ctx context.Context, j contracts.Job) error {
	dir, err := os.MkdirTemp("", "ocms-job-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	input, err := s.download(ctx, j, dir)
	if err != nil {
		return err
	}
	mime, err := s.sourceType(ctx, j.BlobID)
	if err != nil {
		return err
	}

	source, err := os.Open(input)
	if err != nil {
		return err
	}
	header := make([]byte, 512)
	n, _ := source.Read(header)
	source.Close()
	detected := http.DetectContentType(header[:n])
	if strings.HasPrefix(mime, "image/") && !strings.HasPrefix(detected, "image/") {
		return processingError("MIME_MISMATCH")
	}
	if mime == "application/pdf" && !bytes.HasPrefix(header[:n], []byte("%PDF-")) {
		return processingError("MIME_MISMATCH")
	}
	index := contracts.Index{BlobID: j.BlobID}
	metadata := map[string]any{}
	if mime == "application/pdf" {
		err = s.processPDF(ctx, j, input, dir, &index, metadata)
	} else {
		info, e := probe(ctx, input)
		if e != nil {
			return e
		}
		metadata["probe"] = info
		duration, _ := strconv.ParseFloat(info.Format.Duration, 64)
		index.Duration = int64(duration * 1000)
		hasAudio := false
		for _, stream := range info.Streams {
			if stream.Type == "audio" {
				hasAudio = true
			}
		}
		switch {
		case strings.HasPrefix(mime, "image/"):
			frame := filepath.Join(dir, "image.png")
			display := filepath.Join(dir, "display.webp")
			if err = previewAndThumbnail(ctx, input, frame, display, true); err != nil {
				return err
			}
			if err = s.storeOutput(ctx, j, display, "thumbnail.display-v1", "image/webp"); err != nil {
				return err
			}
			out := filepath.Join(dir, "image.webp")
			if err = ffmpeg(ctx, input, out, "-frames:v", "1", "-c:v", "libwebp", "-quality", "82"); err != nil {
				return err
			}
			if err = s.storeOutput(ctx, j, out, "image.webp-v1", "image/webp"); err != nil {
				return err
			}
			h, e := hashImage(ctx, display)
			if e != nil {
				return e
			}
			index.Hashes = append(index.Hashes, contracts.Hash{Kind: "image", Hash: h})
			text, e := ocr(ctx, frame)
			if e != nil {
				return e
			}
			if text != "" {
				index.Passages = append(index.Passages, contracts.Passage{Kind: "ocr", Content: text})
			}
		case strings.HasPrefix(mime, "video/"):
			if duration > 600 {
				return processingError("MEDIA_DURATION_EXCEEDED")
			}
			for n := 0; n < min(12, max(1, int(math.Ceil(duration/5)))); n++ {
				frame := filepath.Join(dir, fmt.Sprintf("frame-%02d.png", n))
				if err = ffmpegAt(ctx, input, frame, strconv.Itoa(n*5), "-frames:v", "1", "-vf", "scale=512:512:force_original_aspect_ratio=decrease"); err != nil {
					return err
				}
				if n == 0 {
					if err = s.storeOutput(ctx, j, frame, "thumbnail-v1", "image/png"); err != nil {
						return err
					}
					out := filepath.Join(dir, "video.mp4")
					if err = ffmpeg(ctx, input, out, "-map", "0:v:0", "-map", "0:a?", "-vf", "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"); err != nil {
						return err
					}
					if err = s.storeOutput(ctx, j, out, "video.mp4-v1", "video/mp4"); err != nil {
						return err
					}
				}
				h, e := hashImage(ctx, frame)
				if e != nil {
					return e
				}
				ms := int64(n * 5000)
				index.Hashes = append(index.Hashes, contracts.Hash{Kind: "video_frame", Ordinal: n, Frame: &ms, Hash: h})
			}
		case strings.HasPrefix(mime, "audio/"):
			out := filepath.Join(dir, "audio.ogg")
			if err = ffmpeg(ctx, input, out, "-vn", "-c:a", "libopus", "-b:a", "96000"); err != nil {
				return err
			}
			if err = s.storeOutput(ctx, j, out, "audio.opus-v1", "audio/ogg"); err != nil {
				return err
			}
		default:
			return processingError("MEDIA_UNSUPPORTED")
		}
		if hasAudio {
			if err = s.audioAnalysis(ctx, input, dir, &index); err != nil {
				return err
			}
		}
	}
	if err != nil {
		return err
	}
	encoded, _ := json.Marshal(metadata)
	_, err = s.DB.Exec(ctx, `INSERT INTO media.blob_metadata(blob_id,mime_type,metadata) VALUES($1,$2,$3) ON CONFLICT(blob_id) DO UPDATE SET mime_type=excluded.mime_type,metadata=excluded.metadata`, j.BlobID, mime, encoded)
	if err != nil {
		return err
	}
	return platform.Call(ctx, "POST", s.Search+"/internal/index", "", index, nil)
}
func ocr(ctx context.Context, path string) (string, error) {
	ctx, end := platform.Span(ctx, "media.ocr")
	defer end()
	out, err := command(ctx, "tesseract", path, "stdout", "-l", "eng+jpn", "--psm", "6")
	return strings.TrimSpace(string(out)), err
}
func (s *Service) processPDF(ctx context.Context, j contracts.Job, input, dir string, index *contracts.Index, metadata map[string]any) error {
	info, err := command(ctx, "pdfinfo", input)
	if err != nil {
		return err
	}
	pages := 0
	for _, line := range strings.Split(string(info), "\n") {
		if strings.HasPrefix(line, "Pages:") {
			pages, _ = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "Pages:")))
		}
	}
	limit := pdfPageLimit()
	slog.InfoContext(ctx, "media.pdf_pages", "job_id", j.ID, "pages", pages, "limit", limit)
	if pages < 1 {
		return processingError("MEDIA_INVALID_DATA")
	}
	if pages > limit {
		return processingError("PDF_PAGE_LIMIT")
	}
	metadata["pages"] = pages
	// Extract the text layer once. A file avoids command()'s diagnostic-sized
	// stdout cap; form feeds preserve empty pages and page attribution.
	textPath := filepath.Join(dir, "text")
	if _, err = command(ctx, "pdftotext", input, textPath); err != nil {
		return err
	}
	textFile, err := os.Open(textPath)
	if err != nil {
		return err
	}
	defer textFile.Close()
	stat, err := textFile.Stat()
	if err != nil {
		return err
	}
	if stat.Size() > maxWorkBytes {
		return processingError("OUTPUT_TOO_LARGE")
	}
	textPages := bufio.NewReader(textFile)
	var images map[int]string
	for p := 1; p <= pages; p++ {
		// Save the first page promptly, then amortize parsing in bounded batches.
		if p == 1 || (p-2)%8 == 0 {
			last := p
			if p > 1 {
				last = min(p+7, pages)
			}
			images, err = renderPDFBatch(ctx, input, dir, p, last)
			if err != nil {
				return err
			}
		}
		rendered := images[p]
		imagePath := filepath.Join(dir, "preview.png")
		display := filepath.Join(dir, "display.webp")
		if err = previewAndThumbnail(ctx, rendered, imagePath, display, false); err != nil {
			return err
		}
		if err = os.Remove(rendered); err != nil {
			return err
		}
		if err = s.storeOutput(ctx, j, imagePath, fmt.Sprintf("pdf.page-%d-v1", p), "image/png"); err != nil {
			return err
		}
		if err = s.storeOutput(ctx, j, display, fmt.Sprintf("pdf.display-%d-v1", p), "image/webp"); err != nil {
			return err
		}
		h, e := hashImage(ctx, display)
		if e != nil {
			return e
		}
		page := p
		index.Hashes = append(index.Hashes, contracts.Hash{Kind: "pdf_page", Ordinal: p - 1, Page: &page, Hash: h})
		text, err := readPDFTextPage(textPages)
		if err != nil {
			return err
		}
		content := text
		kind := "pdf_text"
		if content == "" {
			content, err = ocr(ctx, imagePath)
			kind = "ocr"
			if err != nil {
				return err
			}
		}
		if content != "" {
			index.Passages = append(index.Passages, contracts.Passage{Kind: kind, Ordinal: p - 1, Page: &page, Content: content})
		}
		if err = os.Remove(imagePath); err != nil {
			return err
		}
		slog.InfoContext(ctx, "media.pdf_page_completed", "job_id", j.ID, "page", p, "pages", pages)
	}
	return nil
}

// Preserve page boundaries without allowing a single page to allocate the
// entire extracted document. The previous per-page command had a 2 MiB cap.
func readPDFTextPage(reader *bufio.Reader) (string, error) {
	var text strings.Builder
	for {
		part, err := reader.ReadSlice('\f')
		if text.Len()+len(part) > 2<<20 {
			return "", processingError("OUTPUT_TOO_LARGE")
		}
		text.Write(part)
		if err == bufio.ErrBufferFull {
			continue
		}
		if err == io.EOF {
			err = nil
		}
		return strings.TrimSpace(text.String()), err
	}
}

// Render at most eight pages at once; callers remove each page after use.
func renderPDFBatch(ctx context.Context, input, dir string, first, last int) (map[int]string, error) {
	root := filepath.Join(dir, "page")
	if _, err := command(ctx, "pdftoppm", "-f", strconv.Itoa(first), "-l", strconv.Itoa(last), "-scale-to", "1600", input, root); err != nil {
		return nil, err
	}
	paths, err := filepath.Glob(root + "-*.ppm")
	if err != nil {
		return nil, err
	}
	images := make(map[int]string)
	for _, path := range paths {
		number := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "page-"), ".ppm")
		page, err := strconv.Atoi(number)
		if err != nil || page < first || page > last {
			return nil, processingError("MEDIA_INVALID_DATA")
		}
		images[page] = path
	}
	if len(images) != last-first+1 {
		return nil, processingError("MEDIA_INVALID_DATA")
	}
	return images, nil
}

func (s *Service) audioAnalysis(ctx context.Context, input, dir string, index *contracts.Index) error {
	raw, err := command(ctx, "fpcalc", "-raw", "-json", input)
	if err != nil {
		return err
	}
	var fp struct {
		Duration    float64  `json:"duration"`
		Fingerprint []uint32 `json:"fingerprint"`
	}
	if json.Unmarshal(raw, &fp) != nil {
		return processingError("FINGERPRINT_FAILED")
	}
	index.Fingerprint = make([]int32, len(fp.Fingerprint))
	for i, v := range fp.Fingerprint {
		index.Fingerprint[i] = int32(v)
	}
	index.Duration = int64(fp.Duration * 1000)
	// ASR chunks preserve absolute timestamps and cap each inference payload.
	for offset := 0; offset < max(1, int(math.Ceil(fp.Duration))); offset += 60 {
		path := filepath.Join(dir, "speech.wav")
		if err = ffmpeg(ctx, input, path, "-ss", strconv.Itoa(offset), "-t", "60", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"); err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var out struct {
			Passages []contracts.Passage `json:"passages"`
		}
		asrCtx, asrEnd := platform.Span(ctx, "media.transcribe")
		err = platform.Call(asrCtx, "POST", s.Runtime+"/transcribe", "", map[string]any{"kind": "audio", "data": base64.StdEncoding.EncodeToString(data)}, &out)
		asrEnd()
		if err != nil {
			return processingError("TRANSCRIPTION_FAILED")
		}
		for _, p := range out.Passages {
			p.Ordinal = len(index.Passages)
			if p.Start != nil {
				*p.Start += int64(offset * 1000)
			}
			if p.End != nil {
				*p.End += int64(offset * 1000)
			}
			index.Passages = append(index.Passages, p)
		}
	}
	return nil
}

var dctCosines = func() [8][32]float64 {
	var table [8][32]float64
	for u := range table {
		for x := range table[u] {
			table[u][x] = math.Cos((float64(2*x+1) * float64(u) * math.Pi) / 64)
		}
	}
	return table
}()

// hashImage computes a 64-bit DCT pHash from 32x32 luminance samples.
func hashImage(ctx context.Context, path string) (string, error) {
	raw, err := command(ctx, "ffmpeg", "-v", "error", "-nostdin", "-threads", "1", "-i", path, "-vf", "scale=32:32,format=gray", "-frames:v", "1", "-f", "rawvideo", "-")
	if err != nil || len(raw) != 1024 {
		return "", processingError("FINGERPRINT_FAILED")
	}
	return phash(raw), nil
}
func phash(samples []byte) string {
	var coefficients [64]float64
	for u := 0; u < 8; u++ {
		for v := 0; v < 8; v++ {
			var sum float64
			for x := 0; x < 32; x++ {
				for y := 0; y < 32; y++ {
					sum += float64(samples[x*32+y]) * dctCosines[u][x] * dctCosines[v][y]
				}
			}
			coefficients[u*8+v] = sum
		}
	}
	values := append([]float64(nil), coefficients[1:]...)
	sort.Float64s(values)
	median := values[len(values)/2]
	var bits strings.Builder
	for i, c := range coefficients {
		if i > 0 && c > median {
			bits.WriteByte('1')
		} else {
			bits.WriteByte('0')
		}
	}
	return bits.String()
}

// Check dimensions without decoding full images in the Go process when used by tests/tools.
func imageDimensions(path string) (int, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	c, _, err := image.DecodeConfig(f)
	return c.Width, c.Height, err
}

func toolFailure(ctx context.Context, diagnostic string) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	text := strings.ToLower(diagnostic)
	switch {
	case strings.Contains(text, "no space left on device"):
		return processingError("WORKSPACE_EXHAUSTED")
	case strings.Contains(text, "cannot allocate memory"), strings.Contains(text, "out of memory"):
		return processingError("MEDIA_MEMORY_EXCEEDED")
	case strings.Contains(text, "invalid data found"), strings.Contains(text, "moov atom not found"), strings.Contains(text, "invalid png signature"):
		return processingError("MEDIA_INVALID_DATA")
	default:
		return processingError("MEDIA_TOOL_FAILED")
	}
}
