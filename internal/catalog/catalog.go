package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"ocms/internal/platform"
)

type Service struct {
	DB      *pgxpool.Pool
	MaxSize int64
}
type Asset struct {
	ID       string   `json:"asset_id"`
	Filename string   `json:"filename"`
	MIME     string   `json:"mime_type"`
	Tags     []string `json:"tags"`
	Status   string   `json:"status"`
	BlobID   *string  `json:"blob_id,omitempty"`
}
type Upload struct {
	ID      string  `json:"upload_id"`
	AssetID string  `json:"asset_id"`
	Size    int64   `json:"size_bytes"`
	State   string  `json:"state"`
	BlobID  *string `json:"blob_id,omitempty"`
}

func (s *Service) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /internal/assets/{id}/authorize", s.authorizeAsset)
	m.HandleFunc("GET /internal/events", s.events)
	m.HandleFunc("POST /internal/events/{id}/ack", s.ackEvent)
	m.HandleFunc("GET /internal/blobs/{id}/info", s.blobInfo)
	m.HandleFunc("POST /internal/blobs/{id}/state", s.blobState)
	m.HandleFunc("POST /internal/authorize-blobs", s.authorizeBlobs)

	m.HandleFunc("POST /internal/principals", s.principal)
	m.HandleFunc("POST /api/v1/uploads", s.create)
	m.HandleFunc("GET /api/v1/uploads/{id}", s.upload)
	m.HandleFunc("POST /internal/uploads/{id}/complete", s.complete)
	m.HandleFunc("GET /api/v1/assets", s.list)
	m.HandleFunc("GET /api/v1/assets/{id}", s.detail)
	m.HandleFunc("GET /api/v1/assets/{id}/duplicates", s.duplicates)
	m.HandleFunc("PATCH /api/v1/assets/{id}", s.patch)
	m.HandleFunc("DELETE /api/v1/assets/{id}", s.remove)
	m.HandleFunc("POST /internal/assets/{id}/grants", s.grant)
	return platform.Internal(m)
}
func user(r *http.Request) string { return r.Header.Get("X-Principal") }
func validID(v string) bool {
	if len(v) != 36 {
		return false
	}
	for i, c := range v {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func guard(w http.ResponseWriter, r *http.Request) bool {
	if !validID(user(r)) {
		platform.Error(w, 401, "AUTH_REQUIRED")
		return false
	}
	if id := r.PathValue("id"); id != "" && !validID(id) {
		platform.Error(w, 404, "NOT_FOUND")
		return false
	}
	return true
}
func (s *Service) principal(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Issuer  string `json:"issuer"`
		Subject string `json:"subject"`
	}
	if !platform.Decode(w, r, &in) {
		return
	}
	if in.Issuer == "" || in.Subject == "" {
		platform.Error(w, 400, "INVALID_REQUEST")
		return
	}
	var id string
	err := s.DB.QueryRow(r.Context(), `INSERT INTO catalog.principals(oidc_issuer,oidc_subject) VALUES($1,$2) ON CONFLICT(kind,oidc_issuer,oidc_subject) DO UPDATE SET oidc_subject=excluded.oidc_subject RETURNING id`, in.Issuer, in.Subject).Scan(&id)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	platform.JSON(w, 200, map[string]string{"principal_id": id})
}
func (s *Service) create(w http.ResponseWriter, r *http.Request) {
	ctx, end := platform.Span(r.Context(), "catalog.create_upload")
	defer end()
	r = r.WithContext(ctx)
	if !guard(w, r) {
		return
	}
	var in struct {
		Filename string `json:"filename"`
		MIME     string `json:"mime_type"`
		Size     int64  `json:"size_bytes"`
	}
	if !platform.Decode(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Filename) == "" || len(in.Filename) > 1024 || in.Size < 0 || in.Size > s.MaxSize || !(strings.HasPrefix(in.MIME, "image/") || strings.HasPrefix(in.MIME, "video/") || strings.HasPrefix(in.MIME, "audio/") || in.MIME == "application/pdf") {
		platform.Error(w, 400, "MEDIA_UNSUPPORTED")
		return
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer tx.Rollback(r.Context())

	var out Upload
	key := r.Header.Get("Idempotency-Key")
	if len(key) > 256 {
		platform.Error(w, 400, "INVALID_REQUEST")
		return
	}
	payload, _ := json.Marshal(in)
	if key != "" {
		_, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,1))`, user(r)+":"+key)
		if err != nil {
			platform.RespondError(w, err)
			return
		}
		var matches bool
		err = tx.QueryRow(r.Context(), `SELECT u.id,u.asset_id,u.expected_size,u.state,k.request=$3::jsonb FROM catalog.upload_request_keys k JOIN catalog.upload_sessions u ON u.id=k.upload_id WHERE k.principal_id=$1 AND k.idempotency_key=$2`, user(r), key, payload).Scan(&out.ID, &out.AssetID, &out.Size, &out.State, &matches)
		if err == nil {
			if !matches {
				platform.Error(w, 409, "IDEMPOTENCY_CONFLICT")
				return
			}
			platform.JSON(w, 201, out)
			return
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			platform.RespondError(w, err)
			return
		}
	}
	err = tx.QueryRow(r.Context(), `INSERT INTO catalog.assets(owner_id,filename,mime_type) VALUES($1,$2,$3) RETURNING id`, user(r), in.Filename, in.MIME).Scan(&out.AssetID)
	if err == nil {
		err = tx.QueryRow(r.Context(), `INSERT INTO catalog.upload_sessions(asset_id,expected_size,idempotency_key) VALUES($1,$2,NULLIF($3,'')) RETURNING id,state,expected_size`, out.AssetID, in.Size, r.Header.Get("Idempotency-Key")).Scan(&out.ID, &out.State, &out.Size)
	}
	if err == nil && key != "" {
		_, err = tx.Exec(r.Context(), `INSERT INTO catalog.upload_request_keys(principal_id,idempotency_key,upload_id,request) VALUES($1,$2,$3,$4::jsonb)`, user(r), key, out.ID, payload)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	platform.Audit(r.Context(), "asset.created", user(r), out.AssetID)
	platform.JSON(w, 201, out)
}
func (s *Service) getUpload(ctx context.Context, id, principal string) (Upload, error) {
	var u Upload
	err := s.DB.QueryRow(ctx, `SELECT u.id,u.asset_id,u.expected_size,u.state,o.blob_id FROM catalog.upload_sessions u JOIN catalog.assets a ON a.id=u.asset_id LEFT JOIN catalog.asset_originals o ON o.asset_id=a.id WHERE u.id=$1 AND a.owner_id=$2 AND a.deleted_at IS NULL AND (u.expires_at>now() OR u.state='completed')`, id, principal).Scan(&u.ID, &u.AssetID, &u.Size, &u.State, &u.BlobID)
	return u, err
}
func (s *Service) upload(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	u, err := s.getUpload(r.Context(), r.PathValue("id"), user(r))
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "NOT_FOUND")
		return
	}
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	platform.JSON(w, 200, u)
}
func (s *Service) complete(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	var in struct {
		BlobID string `json:"blob_id"`
	}
	if !platform.Decode(w, r, &in) {
		return
	}
	if !validID(in.BlobID) {
		platform.Error(w, 400, "INVALID_REQUEST")
		return
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var assetID, state string
	err = tx.QueryRow(r.Context(), `SELECT u.asset_id,u.state FROM catalog.upload_sessions u JOIN catalog.assets a ON a.id=u.asset_id WHERE u.id=$1 AND a.owner_id=$2 AND a.deleted_at IS NULL AND (u.expires_at>now() OR u.state='completed') FOR UPDATE OF u,a`, r.PathValue("id"), user(r)).Scan(&assetID, &state)
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "NOT_FOUND")
		return
	}
	if err == nil && state == "completed" {
		var existing string
		err = tx.QueryRow(r.Context(), `SELECT blob_id FROM catalog.asset_originals WHERE asset_id=$1`, assetID).Scan(&existing)
		if err == nil && existing != in.BlobID {
			platform.Error(w, 409, "CONFLICT")
			return
		}
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO catalog.asset_originals(asset_id,blob_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, assetID, in.BlobID)
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), `UPDATE catalog.upload_sessions SET state='completed' WHERE id=$1`, r.PathValue("id"))
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), `UPDATE catalog.assets SET status='stored',updated_at=now() WHERE id=$1`, assetID)
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO catalog.outbox_events(blob_id,event_type,traceparent) VALUES($1,'blob.stored',$2) ON CONFLICT DO NOTHING`, in.BlobID, r.Header.Get("Traceparent"))
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	platform.JSON(w, 200, map[string]string{"asset_id": assetID, "state": "completed"})
}

const selectAsset = `SELECT a.id,a.filename,a.mime_type,a.tags,a.status,o.blob_id FROM catalog.assets a LEFT JOIN catalog.asset_originals o ON o.asset_id=a.id `
const allowed = `a.deleted_at IS NULL AND (a.owner_id=$1 OR EXISTS(SELECT 1 FROM catalog.grants g WHERE g.asset_id=a.id AND g.principal_id=$1))`

func scanAsset(row pgx.Row) (Asset, error) {
	var a Asset
	err := row.Scan(&a.ID, &a.Filename, &a.MIME, &a.Tags, &a.Status, &a.BlobID)
	return a, err
}
func (s *Service) readable(ctx context.Context, id, principal string) (Asset, error) {
	return scanAsset(s.DB.QueryRow(ctx, selectAsset+`WHERE `+allowed+` AND a.id=$2`, principal, id))
}
func assetError(w http.ResponseWriter, err error) bool {
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "NOT_FOUND")
		return true
	}
	if err != nil {
		platform.RespondError(w, err)
		return true
	}
	return false
}
func (s *Service) detail(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	a, err := s.readable(r.Context(), r.PathValue("id"), user(r))
	if assetError(w, err) {
		return
	}
	platform.JSON(w, 200, a)
}

type listOptions struct {
	limit  int
	offset int
	kind   string
}

func parseListOptions(r *http.Request) (listOptions, error) {
	options := listOptions{limit: 200, kind: r.URL.Query().Get("kind")}
	for key, target := range map[string]*int{"limit": &options.limit, "offset": &options.offset} {
		if values, ok := r.URL.Query()[key]; ok {
			if len(values) != 1 {
				return options, errors.New("duplicate pagination parameter")
			}
			value, err := strconv.Atoi(values[0])
			if err != nil || value < 0 || (key == "limit" && (value == 0 || value > 200)) {
				return options, errors.New("invalid pagination parameter")
			}
			*target = value
		}
	}
	switch options.kind {
	case "", "image", "video", "audio", "document":
		return options, nil
	default:
		return options, errors.New("invalid asset kind")
	}
}

func (s *Service) list(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	options, err := parseListOptions(r)
	if err != nil {
		platform.Error(w, 400, "INVALID_PAGINATION")
		return
	}
	q := r.URL.Query().Get("q")
	where := `WHERE ` + allowed + ` AND ($2='' OR strpos(lower(a.filename),lower($2))>0 OR EXISTS(SELECT 1 FROM unnest(a.tags) t WHERE strpos(lower(t),lower($2))>0)) AND ($3='' OR split_part(a.mime_type,'/',1)=$3 OR ($3='document' AND split_part(a.mime_type,'/',1) NOT IN ('image','video','audio')))`
	var total int
	err = s.DB.QueryRow(r.Context(), `SELECT count(*) FROM catalog.assets a `+where, user(r), q, options.kind).Scan(&total)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	rows, err := s.DB.Query(r.Context(), selectAsset+where+` ORDER BY a.created_at DESC,a.id DESC LIMIT $4 OFFSET $5`, user(r), q, options.kind, options.limit, options.offset)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer rows.Close()
	items := []Asset{}
	for rows.Next() {
		a, err := scanAsset(rows)
		if err != nil {
			platform.RespondError(w, err)
			return
		}
		items = append(items, a)
	}
	if rows.Err() != nil {
		platform.RespondError(w, rows.Err())
		return
	}
	platform.JSON(w, 200, map[string]any{"assets": items, "total": total})
}
func (s *Service) duplicates(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	a, err := s.readable(r.Context(), r.PathValue("id"), user(r))
	if assetError(w, err) {
		return
	}
	items := []Asset{}
	if a.BlobID != nil {
		rows, err := s.DB.Query(r.Context(), selectAsset+`WHERE `+allowed+` AND o.blob_id=$2 AND a.id<>$3 ORDER BY a.created_at LIMIT 200`, user(r), *a.BlobID, a.ID)
		if err != nil {
			platform.RespondError(w, err)
			return
		}
		defer rows.Close()
		for rows.Next() {
			a, err := scanAsset(rows)
			if assetError(w, err) {
				return
			}
			items = append(items, a)
		}
		if rows.Err() != nil {
			platform.RespondError(w, rows.Err())
			return
		}
	}
	platform.JSON(w, 200, map[string]any{"assets": items})
}
func (s *Service) patch(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	var in struct {
		Filename *string   `json:"filename"`
		Tags     *[]string `json:"tags"`
	}
	if !platform.Decode(w, r, &in) {
		return
	}
	if in.Filename != nil && (strings.TrimSpace(*in.Filename) == "" || len(*in.Filename) > 1024) {
		platform.Error(w, 400, "INVALID_REQUEST")
		return
	}
	if in.Tags != nil {
		if len(*in.Tags) > 100 {
			platform.Error(w, 400, "INVALID_REQUEST")
			return
		}
		for _, t := range *in.Tags {
			if len(t) > 256 {
				platform.Error(w, 400, "INVALID_REQUEST")
				return
			}
		}
	}
	tag, err := s.DB.Exec(r.Context(), `UPDATE catalog.assets a SET filename=coalesce($3,filename),tags=coalesce($4,tags),updated_at=now() WHERE a.id=$2 AND a.deleted_at IS NULL AND (a.owner_id=$1 OR EXISTS(SELECT 1 FROM catalog.grants g WHERE g.asset_id=a.id AND g.principal_id=$1 AND g.permission IN ('write','admin')))`, user(r), r.PathValue("id"), in.Filename, in.Tags)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		platform.Error(w, 404, "NOT_FOUND")
		return
	}
	platform.Audit(r.Context(), "asset.updated", user(r), r.PathValue("id"))
	s.detail(w, r)
}
func (s *Service) remove(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	tag, err := s.DB.Exec(r.Context(), `UPDATE catalog.assets a SET status='deleted',deleted_at=now(),updated_at=now() WHERE a.id=$2 AND a.deleted_at IS NULL AND (a.owner_id=$1 OR EXISTS(SELECT 1 FROM catalog.grants g WHERE g.asset_id=a.id AND g.principal_id=$1 AND g.permission='admin'))`, user(r), r.PathValue("id"))
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		platform.Error(w, 404, "NOT_FOUND")
		return
	}
	platform.Audit(r.Context(), "asset.deleted", user(r), r.PathValue("id"))
	w.WriteHeader(204)
}
func (s *Service) grant(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	var in struct {
		Principal  string `json:"principal_id"`
		Permission string `json:"permission"`
	}
	if !platform.Decode(w, r, &in) {
		return
	}
	if !validID(in.Principal) || (in.Permission != "read" && in.Permission != "write" && in.Permission != "admin") {
		platform.Error(w, 400, "INVALID_REQUEST")
		return
	}
	tag, err := s.DB.Exec(r.Context(), `INSERT INTO catalog.grants(asset_id,principal_id,permission) SELECT id,$3::uuid,$4 FROM catalog.assets WHERE id=$2 AND owner_id=$1 AND deleted_at IS NULL ON CONFLICT(asset_id,principal_id) DO UPDATE SET permission=excluded.permission`, user(r), r.PathValue("id"), in.Principal, in.Permission)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		platform.Error(w, 404, "NOT_FOUND")
		return
	}
	platform.Audit(r.Context(), "asset.permission_changed", user(r), r.PathValue("id"))
	w.WriteHeader(204)
}
