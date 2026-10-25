package catalog

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Lock each Asset while appending predictions. Manual edits use the same Asset lock.
// Mark independently from general tags, so retries never restore removed characters.
const applyWD14Characters = `WITH applied AS (
 UPDATE catalog.assets a SET wd14_characters_tagged=true,updated_at=now()
 FROM catalog.asset_originals o JOIN catalog.wd14_character_results r ON r.blob_id=o.blob_id
 WHERE a.id=o.asset_id AND o.blob_id=$1 AND NOT a.wd14_characters_tagged AND a.deleted_at IS NULL AND a.id=ANY($2::uuid[])
 RETURNING a.id
) INSERT INTO catalog.asset_characters(asset_id,name,position)
 SELECT a.id,c.name,coalesce((SELECT max(position) FROM catalog.asset_characters WHERE asset_id=a.id),0)+c.n
 FROM applied a CROSS JOIN catalog.wd14_character_results r
 CROSS JOIN LATERAL (SELECT name,min(n)::int AS n FROM unnest(r.characters) WITH ORDINALITY AS c(name,n)
 WHERE NOT EXISTS(SELECT 1 FROM catalog.asset_characters x WHERE x.asset_id=a.id AND x.name=c.name)
 GROUP BY name ORDER BY min(n) LIMIT greatest(0,512-(SELECT count(*)::int FROM catalog.asset_characters WHERE asset_id=a.id))) c
 WHERE r.blob_id=$1 ON CONFLICT DO NOTHING`

func validCharacters(names []string) bool {
	if !validAssetTags(names) {
		return false
	}
	for _, name := range names {
		if strings.TrimSpace(name) == "" {
			return false
		}
	}
	return true
}

// Take the Asset locks in a preceding statement so the relation snapshot includes
// any manual edits that committed while waiting for those locks.
func lockCharacterAssets(ctx context.Context, tx pgx.Tx, blob string) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT a.id FROM catalog.assets a JOIN catalog.asset_originals o ON o.asset_id=a.id WHERE o.blob_id=$1 AND a.deleted_at IS NULL ORDER BY a.id FOR UPDATE OF a`, blob)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Service) reconcileCharacters(ctx context.Context, blob string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	ids, err := lockCharacterAssets(ctx, tx, blob)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, applyWD14Characters, blob, ids); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, applyWD14Rating, blob, ids); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
