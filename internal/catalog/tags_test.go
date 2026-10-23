package catalog

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ocms/internal/contracts"
)

func TestBlobTagsRequiresLiveLeaseBeforeWriting(t *testing.T) {
	const blob = "00000000-0000-4000-8000-000000000001"
	called := false
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.URL.Path != "/internal/jobs/test-job/authorize" {
			t.Errorf("wrong job authorization path")
		}
		var input map[string]string
		if json.NewDecoder(r.Body).Decode(&input) != nil || input["blob_id"] != blob || input["lease_token"] != "test-lease" {
			t.Errorf("missing blob/lease binding")
		}
		w.WriteHeader(403)
	}))
	defer worker.Close()
	t.Setenv("MEDIA_URL", worker.URL)
	t.Setenv("INTERNAL_TOKEN", strings.Repeat("t", 32))
	body := `{"tags":["general"],"characters":["character"],"model_id":"` + contracts.TagModel + `","model_revision":"` + contracts.TagRevision + `"}`
	req := httptest.NewRequest("POST", "/internal/blobs/"+blob+"/tags", strings.NewReader(body))
	req.Header.Set("X-Service-Token", strings.Repeat("t", 32))
	req.Header.Set("X-Job-ID", "test-job")
	req.Header.Set("X-Job-Lease", "test-lease")
	recorder := httptest.NewRecorder()
	// No DB is configured: denied requests must never reach storage.
	(&Service{}).Handler().ServeHTTP(recorder, req)
	if !called || recorder.Code != 403 {
		t.Fatalf("wanted lease denial, got %d", recorder.Code)
	}
}

func TestAssetTagsIncludeRoomForAutomaticLabels(t *testing.T) {
	if !validAssetTags(make([]string, 512)) || validAssetTags(make([]string, 513)) || validAssetTags([]string{strings.Repeat("x", 257)}) {
		t.Fatal("invalid combined tag limit")
	}
}

func TestCharacterValidation(t *testing.T) {
	if !validCharacters([]string{"character"}) || !validCharacters([]string{}) {
		t.Fatal("valid character metadata rejected")
	}
	for _, names := range [][]string{{" "}, {strings.Repeat("x", 257)}, make([]string, 513)} {
		if validCharacters(names) {
			t.Fatal("invalid characters accepted")
		}
	}
}
