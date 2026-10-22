package transfer

import "testing"

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
