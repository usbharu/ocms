package catalog

import (
	"errors"
	"net/http"

	"ocms/internal/platform"
)

const favoriteCondition = `EXISTS(SELECT 1 FROM catalog.asset_favorites f WHERE f.principal_id=$1 AND ((f.asset_id=a.id AND NOT EXISTS(SELECT 1 FROM catalog.series s WHERE s.asset_id=a.id AND s.kind='composite')) OR f.asset_id IN (SELECT m.asset_id FROM catalog.series_members m WHERE m.series_id=a.id AND m.composite)))`

func favoriteFilter(r *http.Request) (bool, error) {
	values, ok := r.URL.Query()["favorites"]
	if !ok {
		return false, nil
	}
	if len(values) != 1 || (values[0] != "true" && values[0] != "false") {
		return false, errors.New("invalid favorites parameter")
	}
	return values[0] == "true", nil
}

func (s *Service) favorite(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	if !validID(r.PathValue("id")) {
		platform.Error(w, 404, "NOT_FOUND")
		return
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if err = seriesLock(r.Context(), tx); err != nil {
		platform.RespondError(w, err)
		return
	}
	// Lock the Asset against concurrent logical deletion.
	var id string
	err = tx.QueryRow(r.Context(), `SELECT a.id FROM catalog.assets a WHERE `+allowed+` AND a.id=$2 FOR UPDATE OF a`, user(r), r.PathValue("id")).Scan(&id)
	if assetError(w, err) {
		return
	}
	if r.Method == http.MethodPut {
		_, err = tx.Exec(r.Context(), `INSERT INTO catalog.asset_favorites(principal_id,asset_id) SELECT $1,$2::uuid WHERE NOT EXISTS(SELECT 1 FROM catalog.series WHERE asset_id=$2 AND kind='composite') ON CONFLICT DO NOTHING`, user(r), id)
		if err == nil {
			_, err = tx.Exec(r.Context(), `INSERT INTO catalog.asset_favorites(principal_id,asset_id) SELECT $1,m.asset_id FROM catalog.series_members m WHERE m.series_id=$2 AND m.composite ON CONFLICT DO NOTHING`, user(r), id)
		}
	} else {
		_, err = tx.Exec(r.Context(), `DELETE FROM catalog.asset_favorites WHERE principal_id=$1 AND (asset_id=$2 OR asset_id IN (SELECT asset_id FROM catalog.series_members WHERE series_id=$2 AND composite))`, user(r), id)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
