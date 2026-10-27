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
	in := map[string]string{"blob_id": r.PathValue("id"), "lease_token": r.Header.Get("X-Job-Lease"), "rendition_blob_id": r.URL.Query().Get("rendition")}
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
	if rendition := r.URL.Query().Get("rendition"); rendition != "" {
		blob = rendition
	}
	s.serveBlob(w, r, catalog.Asset{ID: blob, BlobID: &blob, MIME: "application/octet-stream"}, "media-worker")
}
func (s *Service) derivative(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeJob(w, r) {
		return
	}
	profile := r.URL.Query().Get("profile")
	// Versioned fixed profiles prevent caller-controlled reuse of a different transform.
	switch profile {
	case "image.webp-v1", "thumbnail-v1", "thumbnail.display-v1", "video.mp4-v1", "audio.opus-v1", "pdf.page-1-v1":
	default:
		if !validPDFProfile(profile) && !validPDFThumbnailProfile(profile) && !validPDFDisplayProfile(profile) {
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
	var selected *contracts.Rendition
	if preview {
		selected = selectPreview(list.Renditions, r.URL.Query().Get("page"), r.URL.Query().Get("thumbnail") == "1")
	} else {
		for i := range list.Renditions {
			if list.Renditions[i].ID == r.PathValue("rendition") {
				selected = &list.Renditions[i]
				break
			}
		}
	}
	if selected != nil {
		a.BlobID = &selected.BlobID
		a.MIME = selected.MIME
		s.serveBlob(w, r, a, user)
		return
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

func validPDFThumbnailProfile(profile string) bool {
	return strings.HasPrefix(profile, "pdf.thumbnail-") && validPDFProfile(strings.Replace(profile, "pdf.thumbnail-", "pdf.page-", 1))
}

func validPDFDisplayProfile(profile string) bool {
	return strings.HasPrefix(profile, "pdf.display-") && validPDFProfile(strings.Replace(profile, "pdf.display-", "pdf.page-", 1))
}

func selectPreview(renditions []contracts.Rendition, page string, thumbnail bool) *contracts.Rendition {
	if page == "" {
		page = "1"
	}
	profiles := []string{"thumbnail.display-v1", "thumbnail-v1", "pdf.page-" + page + "-v1"}
	if thumbnail {
		profiles = []string{"thumbnail.display-v1", "pdf.display-" + page + "-v1", "thumbnail-v1", "pdf.page-" + page + "-v1"}
	}
	for _, profile := range profiles {
		for i := range renditions {
			if renditions[i].Profile == profile {
				return &renditions[i]
			}
		}
	}
	return nil
}
