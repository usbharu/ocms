package transfer

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPDFPageProfilesUseSharedConfiguredLimit(t *testing.T) {
	t.Setenv("MEDIA_MAX_PDF_PAGES", "")
	for _, profile := range []string{"pdf.page-1-v1", "pdf.page-50-v1", "pdf.page-51-v1", "pdf.page-70-v1", "pdf.page-500-v1"} {
		if !validPDFProfile(profile) {
			t.Fatal("valid page rejected:", profile)
		}
	}
	for _, profile := range []string{"pdf.page-0-v1", "pdf.page-501-v1", "pdf.page-../-v1", "pdf.page-1-v2"} {
		if validPDFProfile(profile) {
			t.Fatal("invalid page accepted:", profile)
		}
	}
	t.Setenv("MEDIA_MAX_PDF_PAGES", "70")
	if !validPDFProfile("pdf.page-70-v1") || validPDFProfile("pdf.page-71-v1") {
		t.Fatal("configured limit ignored")
	}
}

func TestPDFThumbnailProfilesUseSharedLimit(t *testing.T) {
	t.Setenv("MEDIA_MAX_PDF_PAGES", "70")
	for _, profile := range []string{"pdf.thumbnail-1-v1", "pdf.thumbnail-70-v1"} {
		if !validPDFThumbnailProfile(profile) {
			t.Fatal("valid thumbnail rejected")
		}
	}
	for _, profile := range []string{"pdf.thumbnail-0-v1", "pdf.thumbnail-71-v1", "pdf.thumbnail-../-v1", "pdf.page-1-v1", "pdf.thumbnail-1-v2"} {
		if validPDFThumbnailProfile(profile) {
			t.Fatal("invalid thumbnail accepted")
		}
	}
}

func TestWorkerRenditionReadRequiresJobAuthorization(t *testing.T) {
	for _, rendition := range []string{"", "derived-blob"} {
		t.Run(rendition, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var in map[string]string
				if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
					t.Error(err)
				}
				if r.URL.Path != "/internal/jobs/job-id/authorize" || in["blob_id"] != "source-blob" || in["lease_token"] != "lease" || in["rendition_blob_id"] != rendition {
					t.Error("incorrect Job or rendition authorization")
				}
				w.WriteHeader(403)
			}))
			defer upstream.Close()
			t.Setenv("MEDIA_URL", upstream.URL)
			req := httptest.NewRequest("GET", "/internal/blobs/source-blob/content?rendition="+rendition, nil)
			req.SetPathValue("id", "source-blob")
			req.Header.Set("X-Job-ID", "job-id")
			req.Header.Set("X-Job-Lease", "lease")
			response := httptest.NewRecorder()
			// No DB or S3: a rejected lease must return before either is accessed.
			(&Service{}).workerRead(response, req)
			if response.Code != 403 {
				t.Fatalf("unexpected status %d", response.Code)
			}
		})
	}
}
