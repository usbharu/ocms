package contracts

// BlobProcessingState is an idempotent Worker notification. Revisions increase
// whenever Jobs for the Blob change and let Catalog reject out-of-order delivery.
type BlobProcessingState struct {
	Revision int64  `json:"revision"`
	Status   string `json:"status"`
}
