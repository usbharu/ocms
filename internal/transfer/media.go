package transfer

import (
	"fmt"
	"net/http"
	"ocms/internal/catalog"
	"ocms/internal/contracts"
	"ocms/internal/platform"
	"os"
	"strconv"
	"strings"
)

func stringID(b []byte) string {
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
func (s *Service) authorizeJob(w http.ResponseWriter, r *http.Request) bool {
	in := map[string]string{"blob_id": r.PathValue("id"), "lease_token": r.Header.Get("X-Job-Lease")}
	if err := platform.Call(r.Context(), "POST", os.Getenv("MEDIA_URL")+"/internal/jobs/"+r.Header.Get("X-Job-ID")+"/authorize", "", in, nil); err != nil {
		platform.Error(w, 403, "JOB_FORBIDDEN")
		return false
	}
	return true
}
func (s *Service) workerRead(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeJob(w, r) {
		return
	}
	blob := r.PathValue("id")
	s.serveBlob(w, r, catalog.Asset{ID: blob, BlobID: &blob, MIME: "application/octet-stream"}, "media-worker")
}
func (s *Service) derivative(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeJob(w, r) {
		return
	}
	profile := r.URL.Query().Get("profile")
	// Versioned fixed profiles prevent caller-controlled reuse of a different transform.
	switch profile {
	case "image.webp-v1", "thumbnail-v1", "video.mp4-v1", "audio.opus-v1", "pdf.page-1-v1":
	default:
		if !validPDFProfile(profile) {
			platform.Error(w, 400, "PROFILE_UNSUPPORTED")
			return
		}
	}
	size, err := strconv.ParseInt(r.Header.Get("X-Size-Bytes"), 10, 64)
	if err != nil || size < 0 {
		platform.Error(w, 400, "INVALID_REQUEST")
		return
	}
	blob, err := s.store(r.Context(), r.Body, size, derivativeOperation(r.PathValue("id"), profile))
	if err != nil {
		storeError(w, err)
		return
	}
	platform.JSON(w, 200, map[string]string{"blob_id": blob})
}
func (s *Service) rendition(w http.ResponseWriter, r *http.Request) { s.derivedContent(w, r, false) }
func (s *Service) preview(w http.ResponseWriter, r *http.Request)   { s.derivedContent(w, r, true) }
func (s *Service) derivedContent(w http.ResponseWriter, r *http.Request, preview bool) {
	var a catalog.Asset
	user := r.Header.Get("X-Principal")
	if err := platform.Call(r.Context(), "GET", s.Catalog+"/api/v1/assets/"+r.PathValue("id"), user, nil, &a); err != nil {
		platform.RespondError(w, err)
		return
	}
	if a.BlobID == nil {
		platform.Error(w, 409, "INDEX_PENDING")
		return
	}
	var list struct {
		Renditions []contracts.Rendition `json:"renditions"`
	}
	if err := platform.Call(r.Context(), "GET", os.Getenv("MEDIA_URL")+"/api/v1/assets/"+a.ID+"/renditions", user, nil, &list); err != nil {
		platform.RespondError(w, err)
		return
	}
	for _, d := range list.Renditions {
		matched := d.ID == r.PathValue("rendition")
		if preview {
			page := r.URL.Query().Get("page")
			if page == "" {
				page = "1"
			}
			matched = d.Profile == "thumbnail-v1" || d.Profile == "pdf.page-"+page+"-v1"
		}
		if matched {
			a.BlobID = &d.BlobID
			a.MIME = d.MIME
			s.serveBlob(w, r, a, user)
			return
		}
	}
	platform.Error(w, 404, "PREVIEW_NOT_FOUND")
}

func validPDFProfile(profile string) bool {
	const prefix = "pdf.page-"
	const suffix = "-v1"
	if !strings.HasPrefix(profile, prefix) || !strings.HasSuffix(profile, suffix) {
		return false
	}
	n, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(profile, prefix), suffix))
	return err == nil && n >= 1 && n <= platform.PDFPageLimit()
}
