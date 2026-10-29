package catalog

import (
	"net/http"
	"ocms/internal/contracts"
	"ocms/internal/platform"
)

func (s *Service) events(w http.ResponseWriter, r *http.Request) {
	rows, err := s.DB.Query(r.Context(), `SELECT id,blob_id,traceparent FROM catalog.outbox_events WHERE delivered_at IS NULL ORDER BY created_at LIMIT 20`)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer rows.Close()
	events := []contracts.Event{}
	for rows.Next() {
		var e contracts.Event
		if err = rows.Scan(&e.ID, &e.BlobID, &e.Traceparent); err != nil {
			platform.RespondError(w, err)
			return
		}
		events = append(events, e)
	}
	if rows.Err() != nil {
		platform.RespondError(w, rows.Err())
		return
	}
	platform.JSON(w, 200, map[string]any{"events": events})
}
func (s *Service) ackEvent(w http.ResponseWriter, r *http.Request) {
	if !validID(r.PathValue("id")) {
		platform.Error(w, 404, "NOT_FOUND")
		return
	}
	_, err := s.DB.Exec(r.Context(), `UPDATE catalog.outbox_events SET delivered_at=now() WHERE id=$1`, r.PathValue("id"))
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	w.WriteHeader(204)
}
func (s *Service) blobInfo(w http.ResponseWriter, r *http.Request) {
	if !validID(r.PathValue("id")) {
		platform.Error(w, 404, "NOT_FOUND")
		return
	}
	var mime string
	err := s.DB.QueryRow(r.Context(), `SELECT a.mime_type FROM catalog.assets a JOIN catalog.asset_originals o ON o.asset_id=a.id WHERE o.blob_id=$1 ORDER BY a.created_at LIMIT 1`, r.PathValue("id")).Scan(&mime)
	if assetError(w, err) {
		return
	}
	platform.JSON(w, 200, map[string]string{"mime_type": mime})
}
func (s *Service) blobState(w http.ResponseWriter, r *http.Request) {
	if !validID(r.PathValue("id")) {
		platform.Error(w, 404, "NOT_FOUND")
		return
	}
	var in struct {
		Status string `json:"status"`
	}
	if !platform.Decode(w, r, &in) {
		return
	}
	if in.Status != "processing" && in.Status != "ready" && in.Status != "failed" {
		platform.Error(w, 400, "INVALID_REQUEST")
		return
	}
	_, err := s.DB.Exec(r.Context(), `UPDATE catalog.assets a SET status=$2,updated_at=now() WHERE a.deleted_at IS NULL AND EXISTS(SELECT 1 FROM catalog.asset_originals o WHERE o.asset_id=a.id AND o.blob_id=$1) AND a.status IS DISTINCT FROM $2`, r.PathValue("id"), in.Status)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	if _, err = s.DB.Exec(r.Context(), applyWD14Tags, r.PathValue("id")); err != nil {
		platform.RespondError(w, err)
		return
	}
	if err = s.reconcileCharacters(r.Context(), r.PathValue("id")); err != nil {
		platform.RespondError(w, err)
		return
	}
	w.WriteHeader(204)
}
func (s *Service) authorizeBlobs(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	var in struct {
		Favorites bool     `json:"favorites"`
		IDs       []string `json:"blob_ids"`
		AssetIDs  []string `json:"asset_ids"`
	}
	if !platform.Decode(w, r, &in) {
		return
	}
	if len(in.IDs)+len(in.AssetIDs) > 1500 {
		platform.Error(w, 400, "INVALID_REQUEST")
		return
	}
	for _, id := range append(in.IDs, in.AssetIDs...) {
		if !validID(id) {
			platform.Error(w, 400, "INVALID_REQUEST")
			return
		}
	}
	filter := ""
	if in.Favorites {
		filter = ` AND ` + favoriteCondition
	}
	rows, err := s.DB.Query(r.Context(), selectAsset+`WHERE `+displayed+` AND (a.blob_ids && $2::text[] OR a.id=ANY($3::uuid[]) OR (a.series_kind='composite' AND a.member_ids && $3::text[]))`+filter+` ORDER BY a.created_at DESC`, user(r), in.IDs, in.AssetIDs)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer rows.Close()
	assets := []Asset{}
	for rows.Next() {
		a, err := scanAsset(rows)
		if assetError(w, err) {
			return
		}
		assets = append(assets, a)
	}
	if rows.Err() != nil {
		platform.RespondError(w, rows.Err())
		return
	}
	platform.JSON(w, 200, map[string]any{"assets": assets})
}

func (s *Service) authorizeAsset(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	action := r.URL.Query().Get("action")
	if action != "write" && action != "admin" {
		platform.Error(w, 400, "INVALID_ACTION")
		return
	}
	permissions := []string{"admin"}
	if action == "write" {
		permissions = append(permissions, "write")
	}
	a, err := scanAsset(s.DB.QueryRow(r.Context(), selectAsset+`WHERE a.deleted_at IS NULL AND a.id=$2 AND (a.owner_id=$1 OR EXISTS(SELECT 1 FROM catalog.grants g WHERE g.asset_id=a.id AND g.principal_id=$1 AND g.permission=ANY($3)))`, user(r), r.PathValue("id"), permissions))
	if assetError(w, err) {
		return
	}
	platform.JSON(w, 200, a)
}
