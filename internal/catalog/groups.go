package catalog

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"ocms/internal/platform"
)

type Group struct {
	ID      string `json:"group_id"`
	Name    string `json:"name"`
	Builtin bool   `json:"builtin"`
}

func (s *Service) groupRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/groups", s.groups)
	m.HandleFunc("POST /api/v1/groups", s.createGroup)
	m.HandleFunc("PATCH /api/v1/groups/{group}", s.changeGroup)
	m.HandleFunc("DELETE /api/v1/groups/{group}", s.changeGroup)
	m.HandleFunc("GET /api/v1/assets/{id}/groups", s.assetGroups)
	m.HandleFunc("PUT /api/v1/assets/{id}/groups", s.assetGroups)
}

// Group membership never grants access. Apply this alongside displayed/allowed.
func groupCondition(index int) string {
	p := fmt.Sprintf("$%d", index)
	return ` (` + p + `='' OR (` + p + `='default' AND NOT EXISTS(SELECT 1 FROM catalog.default_group_exclusions e WHERE e.principal_id=$1 AND e.asset_id=a.id)) OR (` + p + `='all' AND a.series_kind='') OR EXISTS(SELECT 1 FROM catalog.asset_groups g WHERE g.principal_id=$1 AND g.asset_id=a.id AND g.group_id::text=` + p + `))`
}

func (s *Service) checkGroup(ctx context.Context, principal, id string) error {
	if id == "" || id == "default" || id == "all" {
		return nil
	}
	if !validID(id) {
		return pgx.ErrNoRows
	}
	var found string
	return s.DB.QueryRow(ctx, `SELECT id FROM catalog.content_groups WHERE id=$1 AND principal_id=$2`, id, principal).Scan(&found)
}

func (s *Service) requestGroup(w http.ResponseWriter, r *http.Request) (string, bool) {
	values, present := r.URL.Query()["group_id"]
	if present && (len(values) != 1 || values[0] == "") {
		platform.Error(w, 400, "INVALID_GROUP")
		return "", false
	}
	id := r.URL.Query().Get("group_id")
	if assetError(w, s.checkGroup(r.Context(), user(r), id)) {
		return "", false
	}
	return id, true
}

func groupError(w http.ResponseWriter, err error) bool {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" {
		platform.Error(w, 409, "GROUP_NAME_CONFLICT")
		return true
	}
	return assetError(w, err)
}

func groupName(w http.ResponseWriter, r *http.Request) (string, bool) {
	var in struct {
		Name string `json:"name"`
	}
	if !platform.Decode(w, r, &in) {
		return "", false
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || utf8.RuneCountInString(name) > 100 || strings.EqualFold(name, "default") || strings.EqualFold(name, "all") {
		platform.Error(w, 400, "INVALID_GROUP_NAME")
		return "", false
	}
	return name, true
}

func (s *Service) groups(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	out := []Group{{"default", "default", true}, {"all", "all", true}}
	rows, err := s.DB.Query(r.Context(), `SELECT id,name FROM catalog.content_groups WHERE principal_id=$1 ORDER BY name,id`, user(r))
	if groupError(w, err) {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var g Group
		if groupError(w, rows.Scan(&g.ID, &g.Name)) {
			return
		}
		out = append(out, g)
	}
	if groupError(w, rows.Err()) {
		return
	}
	platform.JSON(w, 200, map[string]any{"groups": out})
}

func (s *Service) createGroup(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	name, ok := groupName(w, r)
	if !ok {
		return
	}
	g := Group{Name: name}
	if groupError(w, s.DB.QueryRow(r.Context(), `INSERT INTO catalog.content_groups(principal_id,name) VALUES($1,$2) RETURNING id`, user(r), name).Scan(&g.ID)) {
		return
	}
	platform.JSON(w, 201, g)
}

func (s *Service) changeGroup(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	id := r.PathValue("group")
	if !validID(id) {
		platform.Error(w, 404, "NOT_FOUND")
		return
	}
	if r.Method == "DELETE" {
		result, err := s.DB.Exec(r.Context(), `DELETE FROM catalog.content_groups WHERE id=$1 AND principal_id=$2`, id, user(r))
		if groupError(w, err) {
			return
		}
		if result.RowsAffected() == 0 {
			platform.Error(w, 404, "NOT_FOUND")
			return
		}
		w.WriteHeader(204)
		return
	}
	name, ok := groupName(w, r)
	if !ok {
		return
	}
	var found string
	if groupError(w, s.DB.QueryRow(r.Context(), `UPDATE catalog.content_groups SET name=$3 WHERE id=$1 AND principal_id=$2 RETURNING id`, id, user(r), name).Scan(&found)) {
		return
	}
	platform.JSON(w, 200, Group{ID: found, Name: name})
}

func (s *Service) assetGroups(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	a, err := s.readable(r.Context(), r.PathValue("id"), user(r))
	if assetError(w, err) {
		return
	}
	if r.Method == "PUT" {
		var in struct {
			IDs []string `json:"group_ids"`
		}
		if !platform.Decode(w, r, &in) {
			return
		}
		if len(in.IDs) > 1500 {
			platform.Error(w, 400, "INVALID_GROUP")
			return
		}
		custom := []string{}
		seen := map[string]bool{}
		defaultMember := false
		for _, id := range in.IDs {
			if seen[id] {
				continue
			}
			seen[id] = true
			switch id {
			case "default":
				defaultMember = true
			case "all":
				if a.SeriesKind != "" {
					platform.Error(w, 400, "INVALID_GROUP")
					return
				}
			default:
				if !validID(id) {
					platform.Error(w, 400, "INVALID_GROUP")
					return
				}
				custom = append(custom, id)
			}
		}
		tx, err := s.DB.Begin(r.Context())
		if groupError(w, err) {
			return
		}
		defer tx.Rollback(r.Context())
		// Serialize complete membership saves for this user and Asset.
		_, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,12))`, user(r)+":"+a.ID)
		if groupError(w, err) {
			return
		}
		rows, err := tx.Query(r.Context(), `SELECT id FROM catalog.content_groups WHERE principal_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR KEY SHARE`, user(r), custom)
		if groupError(w, err) {
			return
		}
		count := 0
		for rows.Next() {
			count++
		}
		err = rows.Err()
		rows.Close()
		if groupError(w, err) {
			return
		}
		if count != len(custom) {
			platform.Error(w, 404, "NOT_FOUND")
			return
		}
		_, err = tx.Exec(r.Context(), `DELETE FROM catalog.asset_groups WHERE principal_id=$1 AND asset_id=$2`, user(r), a.ID)
		if err == nil {
			_, err = tx.Exec(r.Context(), `INSERT INTO catalog.asset_groups(group_id,principal_id,asset_id) SELECT unnest($3::uuid[]),$1,$2`, user(r), a.ID, custom)
		}
		if err == nil {
			if defaultMember {
				_, err = tx.Exec(r.Context(), `DELETE FROM catalog.default_group_exclusions WHERE principal_id=$1 AND asset_id=$2`, user(r), a.ID)
			} else {
				_, err = tx.Exec(r.Context(), `INSERT INTO catalog.default_group_exclusions(principal_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, user(r), a.ID)
			}
		}
		if err == nil {
			err = tx.Commit(r.Context())
		}
		if groupError(w, err) {
			return
		}
	}
	ids := []string{}
	if a.SeriesKind == "" {
		ids = append(ids, "all")
	}
	var excluded bool
	if groupError(w, s.DB.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM catalog.default_group_exclusions WHERE principal_id=$1 AND asset_id=$2)`, user(r), a.ID).Scan(&excluded)) {
		return
	}
	if !excluded {
		ids = append(ids, "default")
	}
	rows, err := s.DB.Query(r.Context(), `SELECT group_id FROM catalog.asset_groups WHERE principal_id=$1 AND asset_id=$2 ORDER BY group_id`, user(r), a.ID)
	if groupError(w, err) {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if groupError(w, rows.Scan(&id)) {
			return
		}
		ids = append(ids, id)
	}
	if groupError(w, rows.Err()) {
		return
	}
	platform.JSON(w, 200, map[string]any{"group_ids": ids})
}
