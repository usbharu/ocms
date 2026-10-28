package catalog

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"ocms/internal/platform"
)

const SeriesMIME = "application/vnd.ocms.series"

type seriesInput struct {
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	MemberIDs []string `json:"member_ids"`
	Version   int64    `json:"version"`
}

type SeriesDetail struct {
	Asset
	Members  []Asset `json:"members"`
	Editable bool    `json:"editable"`
}

func (s *Service) seriesRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/series", s.seriesList)
	m.HandleFunc("POST /api/v1/series", s.saveSeries)
	m.HandleFunc("GET /api/v1/series/{id}", s.seriesDetail)
	m.HandleFunc("PATCH /api/v1/series/{id}", s.saveSeries)
	m.HandleFunc("DELETE /api/v1/series/{id}", s.deleteSeries)
	m.HandleFunc("POST /internal/series-candidates", s.seriesCandidates)
}

// Membership, dissolution, deletion and sharing serialize before reading their
// snapshots. Asset row locks also synchronize with upload and metadata updates.
func seriesLock(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(78540311)`)
	return err
}

func validSeries(in seriesInput) bool {
	if strings.TrimSpace(in.Name) == "" || len(in.Name) > 1024 || len(in.MemberIDs) < 2 || len(in.MemberIDs) > 1500 || (in.Kind != "collection" && in.Kind != "composite") {
		return false
	}
	seen := map[string]bool{}
	if in.MemberIDs == nil {
		in.MemberIDs = []string{}
	}
	for _, id := range in.MemberIDs {
		if !validID(id) || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

func (s *Service) seriesList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	q.Set("kind", "series")
	if q.Get("series_kind") == "" {
		q.Set("series_kind", "collection")
	}
	r.URL.RawQuery = q.Encode()
	s.list(w, r)
}

func (s *Service) seriesDetail(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	a, err := scanAsset(tx.QueryRow(r.Context(), selectAsset+`WHERE `+allowed+` AND a.id=$2`, user(r), r.PathValue("id")))
	if assetError(w, err) {
		return
	}
	if a.SeriesKind == "" {
		platform.Error(w, 404, "NOT_FOUND")
		return
	}
	rows, err := tx.Query(r.Context(), selectAsset+`JOIN catalog.series_members m ON m.asset_id=a.id WHERE `+allowed+` AND m.series_id=$2 ORDER BY m.position`, user(r), a.ID)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	members := []Asset{}
	for rows.Next() {
		v, e := scanAsset(rows)
		if e != nil {
			rows.Close()
			platform.RespondError(w, e)
			return
		}
		members = append(members, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	var editable bool
	err = tx.QueryRow(r.Context(), `SELECT owner_id=$1 FROM catalog.assets WHERE id=$2`, user(r), a.ID).Scan(&editable)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		platform.RespondError(w, err)
		return
	}
	platform.JSON(w, 200, SeriesDetail{Asset: a, Members: members, Editable: editable})
}

func (s *Service) saveSeries(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	var in seriesInput
	if !platform.Decode(w, r, &in) {
		return
	}
	if !validSeries(in) {
		platform.Error(w, 400, "INVALID_SERIES")
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
	id := r.PathValue("id")
	var acl string
	if id != "" {
		var kind string
		var version int64
		err = tx.QueryRow(r.Context(), `SELECT s.kind,s.version FROM catalog.series s JOIN catalog.assets a ON a.id=s.asset_id WHERE a.id=$2 AND a.owner_id=$1 AND a.deleted_at IS NULL FOR UPDATE OF a,s`, user(r), id).Scan(&kind, &version)
		if assetError(w, err) {
			return
		}
		if kind != in.Kind || version != in.Version {
			platform.Error(w, 409, "SERIES_CONFLICT")
			return
		}
	}
	// Worker metadata updates lock shared-Blob Assets in ID order too.
	rows, err := tx.Query(r.Context(), `SELECT id FROM catalog.assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, in.MemberIDs)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	for rows.Next() {
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	for i, member := range in.MemberIDs {
		var owner, mime, kind, parent, memberACL string
		var hasOriginal bool
		err = tx.QueryRow(r.Context(), `SELECT a.owner_id,a.mime_type,coalesce(s.kind,''),coalesce((SELECT series_id::text FROM catalog.series_members WHERE asset_id=a.id AND composite),''),coalesce((SELECT string_agg(principal_id::text||':'||permission,',' ORDER BY principal_id) FROM catalog.grants WHERE asset_id=a.id),''),EXISTS(SELECT 1 FROM catalog.asset_originals WHERE asset_id=a.id) FROM catalog.assets a LEFT JOIN catalog.series s ON s.asset_id=a.id WHERE a.id=$1 AND a.deleted_at IS NULL FOR UPDATE OF a`, member).Scan(&owner, &mime, &kind, &parent, &memberACL, &hasOriginal)
		if errors.Is(err, pgx.ErrNoRows) {
			platform.Error(w, 400, "INVALID_SERIES_MEMBER")
			return
		}
		if err != nil {
			platform.RespondError(w, err)
			return
		}
		if (kind == "" && !hasOriginal) || owner != user(r) || member == id || kind == "collection" || (in.Kind == "composite" && (!strings.HasPrefix(mime, "image/") || kind != "" || (parent != "" && parent != id))) || (in.Kind == "collection" && parent != "") {
			platform.Error(w, 400, "INVALID_SERIES_MEMBER")
			return
		}
		if i == 0 {
			acl = memberACL
		} else if acl != memberACL {
			platform.Error(w, 409, "SERIES_ACL_MISMATCH")
			return
		}
	}
	if id == "" {
		err = tx.QueryRow(r.Context(), `INSERT INTO catalog.assets(owner_id,filename,mime_type,status) VALUES($1,$2,$3,'ready') RETURNING id`, user(r), strings.TrimSpace(in.Name), SeriesMIME).Scan(&id)
		if err == nil {
			_, err = tx.Exec(r.Context(), `INSERT INTO catalog.series(asset_id,kind) VALUES($1,$2)`, id, in.Kind)
		}
		if err == nil {
			_, err = tx.Exec(r.Context(), `INSERT INTO catalog.grants(asset_id,principal_id,permission) SELECT $1,principal_id,permission FROM catalog.grants WHERE asset_id=$2`, id, in.MemberIDs[0])
		}
	} else {
		var ownACL string
		err = tx.QueryRow(r.Context(), `SELECT coalesce(string_agg(principal_id::text||':'||permission,',' ORDER BY principal_id),'') FROM catalog.grants WHERE asset_id=$1`, id).Scan(&ownACL)
		if err == nil && ownACL != acl {
			platform.Error(w, 409, "SERIES_ACL_MISMATCH")
			return
		}
		if err == nil {
			_, err = tx.Exec(r.Context(), `UPDATE catalog.assets SET filename=$2,updated_at=now() WHERE id=$1`, id, strings.TrimSpace(in.Name))
		}
		if err == nil {
			_, err = tx.Exec(r.Context(), `DELETE FROM catalog.series_members WHERE series_id=$1`, id)
		}
		if err == nil {
			_, err = tx.Exec(r.Context(), `UPDATE catalog.series SET version=version+1 WHERE asset_id=$1 OR asset_id IN (SELECT series_id FROM catalog.series_members WHERE asset_id=$1)`, id)
		}
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO catalog.series_members(series_id,asset_id,position,composite) SELECT $1,x,n-1,$3 FROM unnest($2::uuid[]) WITH ORDINALITY AS v(x,n)`, id, in.MemberIDs, in.Kind == "composite")
	}
	if err == nil && in.Kind == "composite" {
		err = groupSeriesReferences(r.Context(), tx, id, in.MemberIDs)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	r.SetPathValue("id", id)
	s.seriesDetail(w, r)
}

// Dissolving replaces collection references with the remaining original works.
func dissolveSeries(ctx context.Context, tx pgx.Tx, id string) error {
	rows, err := tx.Query(ctx, `SELECT series_id::text FROM catalog.series_members WHERE asset_id=$1 ORDER BY series_id`, id)
	if err != nil {
		return err
	}
	parents := []string{}
	for rows.Next() {
		var v string
		if err = rows.Scan(&v); err != nil {
			break
		}
		parents = append(parents, v)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	for _, parent := range parents {
		rows, err = tx.Query(ctx, `SELECT coalesce(n.asset_id,m.asset_id)::text FROM catalog.series_members m LEFT JOIN catalog.series_members n ON m.asset_id=$2 AND n.series_id=m.asset_id WHERE m.series_id=$1 ORDER BY m.position,n.position`, parent, id)
		if err != nil {
			return err
		}
		members := []string{}
		seen := map[string]bool{}
		for rows.Next() {
			var v string
			if err = rows.Scan(&v); err != nil {
				break
			}
			if v != id && !seen[v] {
				members = append(members, v)
				seen[v] = true
			}
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM catalog.series_members WHERE series_id=$1`, parent); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO catalog.series_members(series_id,asset_id,position,composite) SELECT $1,x,n-1,false FROM unnest($2::uuid[]) WITH ORDINALITY v(x,n)`, parent, members); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE catalog.series SET version=version+1 WHERE asset_id=$1`, parent); err != nil {
			return err
		}
	}

	_, err = tx.Exec(ctx, `DELETE FROM catalog.series_members WHERE series_id=$1`, id)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE catalog.assets SET deleted_at=now(),status='deleted',updated_at=now() WHERE id=$1`, id)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `DELETE FROM catalog.series WHERE asset_id=$1`, id)
	return err
}

func (s *Service) deleteSeries(w http.ResponseWriter, r *http.Request) { s.remove(w, r) }

// Suggestions use the same ownership, membership and ACL rules as saving.
func (s *Service) seriesCandidates(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	var in struct {
		Kind      string   `json:"kind"`
		MemberIDs []string `json:"member_ids"`
		EditingID string   `json:"editing_id"`
		Query     string   `json:"query"`
		BlobIDs   []string `json:"blob_ids"`
	}
	if !platform.Decode(w, r, &in) {
		return
	}
	if in.Kind != "collection" && in.Kind != "composite" {
		platform.Error(w, 400, "INVALID_SERIES")
		return
	}
	if in.MemberIDs == nil {
		in.MemberIDs = []string{}
	}
	if in.BlobIDs == nil {
		in.BlobIDs = []string{}
	}
	for _, id := range in.MemberIDs {
		if !validID(id) {
			platform.Error(w, 400, "INVALID_REQUEST")
			return
		}
	}
	if in.EditingID != "" && !validID(in.EditingID) {
		platform.Error(w, 400, "INVALID_REQUEST")
		return
	}
	// Reject inaccessible seeds before they can influence suggestions.
	for _, id := range in.MemberIDs {
		a, e := s.readable(r.Context(), id, user(r))
		if assetError(w, e) {
			return
		}
		var own bool
		if e = s.DB.QueryRow(r.Context(), `SELECT owner_id=$1 FROM catalog.assets WHERE id=$2`, user(r), a.ID).Scan(&own); e != nil {
			platform.RespondError(w, e)
			return
		}
		if !own {
			platform.Error(w, 400, "INVALID_SERIES_MEMBER")
			return
		}
	}
	rows, err := s.DB.Query(r.Context(), selectAsset+`WHERE `+displayed+` AND a.owner_id=$1 AND (a.series_kind<>'' OR o.blob_id IS NOT NULL) AND a.id::text<>$5 AND a.series_kind<>'collection' AND NOT(a.id=ANY($2::uuid[]))
 AND ($3='collection' OR (a.mime_type LIKE 'image/%' AND a.series_kind=''))
 AND (cardinality($2::uuid[])=0 OR NOT EXISTS(
 SELECT principal_id,permission FROM catalog.grants WHERE asset_id=a.id EXCEPT SELECT principal_id,permission FROM catalog.grants WHERE asset_id=($2::uuid[])[1]) AND NOT EXISTS(
 SELECT principal_id,permission FROM catalog.grants WHERE asset_id=($2::uuid[])[1] EXCEPT SELECT principal_id,permission FROM catalog.grants WHERE asset_id=a.id))
 AND ($4='' OR strpos(lower(a.filename),lower($4))>0) ORDER BY (a.blob_ids && $6::text[]) DESC, (a.tags && coalesce((SELECT tags FROM catalog.display_assets WHERE id=($2::uuid[])[1]),'{}')) DESC,a.created_at DESC,a.id LIMIT 1000`, user(r), in.MemberIDs, in.Kind, in.Query, in.EditingID, in.BlobIDs)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	out := []Asset{}
	for rows.Next() {
		a, e := scanAsset(rows)
		if e != nil {
			rows.Close()
			platform.RespondError(w, e)
			return
		}
		out = append(out, a)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	platform.JSON(w, 200, map[string]any{"assets": out})
}

// Existing collections must refer to the new logical work, never its hidden pages.
func groupSeriesReferences(ctx context.Context, tx pgx.Tx, id string, members []string) error {
	rows, err := tx.Query(ctx, `SELECT DISTINCT series_id::text FROM catalog.series_members WHERE asset_id=ANY($1::uuid[]) AND NOT composite ORDER BY series_id::text`, members)
	if err != nil {
		return err
	}
	parents := []string{}
	for rows.Next() {
		var p string
		if err = rows.Scan(&p); err != nil {
			break
		}
		parents = append(parents, p)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	replace := map[string]bool{}
	for _, m := range members {
		replace[m] = true
	}
	for _, parent := range parents {
		rows, err = tx.Query(ctx, `SELECT asset_id::text FROM catalog.series_members WHERE series_id=$1 ORDER BY position`, parent)
		if err != nil {
			return err
		}
		next := []string{}
		seen := map[string]bool{}
		for rows.Next() {
			var v string
			if err = rows.Scan(&v); err != nil {
				break
			}
			if replace[v] {
				v = id
			}
			if !seen[v] {
				next = append(next, v)
				seen[v] = true
			}
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM catalog.series_members WHERE series_id=$1`, parent); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO catalog.series_members(series_id,asset_id,position,composite) SELECT $1,x,n-1,false FROM unnest($2::uuid[]) WITH ORDINALITY v(x,n)`, parent, next); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE catalog.series SET version=version+1 WHERE asset_id=$1`, parent); err != nil {
			return err
		}
	}
	return nil
}
