package contracts

type Passage struct {
	Kind    string `json:"kind"`
	Ordinal int    `json:"ordinal"`
	Page    *int   `json:"page_number,omitempty"`
	Start   *int64 `json:"start_ms,omitempty"`
	End     *int64 `json:"end_ms,omitempty"`
	Content string `json:"content"`
}
type Hash struct {
	Kind    string `json:"kind"`
	Ordinal int    `json:"ordinal"`
	Page    *int   `json:"page_number,omitempty"`
	Frame   *int64 `json:"frame_ms,omitempty"`
	Hash    string `json:"phash"`
}
type Embedding struct {
	Source   string    `json:"source_type"`
	Ordinal  int       `json:"ordinal"`
	Page     *int      `json:"page_number,omitempty"`
	Start    *int64    `json:"start_ms,omitempty"`
	End      *int64    `json:"end_ms,omitempty"`
	Model    string    `json:"model_id"`
	Revision string    `json:"model_revision"`
	Vector   []float64 `json:"embedding"`
}
type Index struct {
	BlobID      string      `json:"blob_id"`
	Passages    []Passage   `json:"passages"`
	Hashes      []Hash      `json:"hashes"`
	Fingerprint []int32     `json:"fingerprint"`
	Duration    int64       `json:"duration_ms"`
	Embeddings  []Embedding `json:"embeddings"`
}
type Rendition struct {
	ID      string `json:"rendition_id"`
	Source  string `json:"source_blob_id"`
	BlobID  string `json:"blob_id"`
	Profile string `json:"profile_id"`
	MIME    string `json:"mime_type"`
}
type Job struct {
	ID          string  `json:"job_id"`
	BlobID      string  `json:"source_blob_id"`
	Type        string  `json:"job_type"`
	Status      string  `json:"status"`
	Attempts    int     `json:"attempts"`
	Error       *string `json:"error_code,omitempty"`
	Lease       string  `json:"-"`
	Traceparent string  `json:"-"`
}
type Event struct {
	ID          string `json:"event_id"`
	BlobID      string `json:"blob_id"`
	Traceparent string `json:"traceparent"`
}
