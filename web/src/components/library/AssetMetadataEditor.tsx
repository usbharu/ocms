import { useRef, useState } from 'react';
import type { Asset, AssetChanges } from '../../lib/assets';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

export function AssetMetadataEditor({
  asset,
  onSave,
}: {
  asset: Asset;
  onSave: (changes: AssetChanges) => Promise<Asset>;
}) {
  const [filename, setFilename] = useState(asset.filename);
  const [tags, setTags] = useState(asset.tags);
  const [tagInput, setTagInput] = useState('');
  const [characters, setCharacters] = useState(asset.characters ?? []);
  const [characterInput, setCharacterInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState<AssetChanges | null>(null);
  const locked = useRef(false);
  const savedFilename = useRef(asset.filename);
  const composing = useRef(false);
  const bytes = (value: string) => new TextEncoder().encode(value).length;

  async function save(changes: AssetChanges) {
    if (locked.current) return;
    locked.current = true;
    setSaving(true);
    setError('');
    setMessage('保存中…');
    try {
      const updated = await onSave(changes);
      savedFilename.current = updated.filename;
      if (changes.filename !== undefined) setFilename(updated.filename);
      setTags(updated.tags);
      if (changes.tags) setTagInput('');
      setCharacters(updated.characters ?? []);
      if (changes.characters) setCharacterInput('');
      setRetry(null);
      setMessage('保存しました');
    } catch {
      setError('保存できませんでした。再試行してください。');
      setRetry(changes);
      setMessage('');
    } finally {
      locked.current = false;
      setSaving(false);
    }
  }

  function saveFilename() {
    if (
      composing.current ||
      locked.current ||
      filename === savedFilename.current
    )
      return;
    if (!filename.trim() || bytes(filename) > 1024) {
      setError('ファイル名は空白以外を含む1024バイト以内で入力してください。');
      setRetry(null);
      return;
    }
    void save({ filename });
  }

  function addTag() {
    const tag = tagInput.trim();
    if (locked.current || !tag) return;
    if (tags.includes(tag)) {
      setError('このタグは追加済みです。');
      setRetry(null);
      return;
    }
    if (bytes(tag) > 256 || tags.length >= 512) {
      setError('タグは1件256バイト以内、合計512件まで追加できます。');
      setRetry(null);
      return;
    }
    void save({ tags: [...tags, tag] });
  }

  function addCharacter() {
    const character = characterInput.trim();
    if (locked.current || !character) return;
    if (characters.includes(character)) {
      setError('このキャラクターは追加済みです。');
      setRetry(null);
      return;
    }
    if (bytes(character) > 256 || characters.length >= 512) {
      setError('キャラクターは1件256バイト以内、合計512件まで追加できます。');
      setRetry(null);
      return;
    }
    void save({ characters: [...characters, character] });
  }

  function clearFeedback() {
    setError('');
    setMessage('');
    setRetry(null);
  }

  return (
    <div className="metadata-editor" aria-busy={saving}>
      <details className="rename-field">
        <summary>名前を変更</summary>
        <Label htmlFor="asset-filename" className="visually-hidden">
          ファイル名
        </Label>
        <Input
          id="asset-filename"
          value={filename}
          disabled={saving}
          onChange={(e) => {
            setFilename(e.target.value);
            clearFeedback();
          }}
          onBlur={saveFilename}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(e) => {
            if (
              e.nativeEvent.isComposing ||
              composing.current ||
              e.keyCode === 229
            )
              return;
            if (e.key === 'Enter') {
              e.preventDefault();
              saveFilename();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setFilename(savedFilename.current);
              clearFeedback();
            }
          }}
        />
      </details>
      <Label htmlFor="asset-tag-input">タグ</Label>
      {tags.length > 0 ? (
        <ul className="tag-chips" aria-label="登録済みタグ">
          {tags.map((tag, index) => (
            <li className="tag-chip" key={tag}>
              <span>{tag}</span>
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                aria-label={`タグ「${tag}」を削除`}
                onClick={() => {
                  void save({ tags: tags.filter((_, i) => i !== index) });
                }}
              >
                <span aria-hidden="true">×</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="metadata-hint">タグはありません</p>
      )}
      <form
        className="tag-input"
        onSubmit={(e) => {
          e.preventDefault();
          addTag();
        }}
      >
        <Input
          id="asset-tag-input"
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          value={tagInput}
          disabled={saving}
          placeholder="タグを追加"
          onChange={(e) => {
            setTagInput(e.target.value);
            clearFeedback();
          }}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              (e.nativeEvent.isComposing ||
                composing.current ||
                e.keyCode === 229)
            )
              e.preventDefault();
          }}
        />
        <Button
          variant="outline"
          type="submit"
          disabled={saving || !tagInput.trim()}
        >
          追加
        </Button>
      </form>
      <Label htmlFor="asset-character-input">キャラクター</Label>
      {characters.length > 0 ? (
        <ul className="tag-chips" aria-label="登録済みキャラクター">
          {characters.map((character, index) => (
            <li className="tag-chip" key={character}>
              <span>{character}</span>
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                aria-label={`キャラクター「${character}」を削除`}
                onClick={() => {
                  void save({
                    characters: characters.filter((_, i) => i !== index),
                  });
                }}
              >
                <span aria-hidden="true">×</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="metadata-hint">キャラクターはありません</p>
      )}
      <form
        className="tag-input"
        onSubmit={(e) => {
          e.preventDefault();
          addCharacter();
        }}
      >
        <Input
          id="asset-character-input"
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          value={characterInput}
          disabled={saving}
          placeholder="キャラクターを追加"
          onChange={(e) => {
            setCharacterInput(e.target.value);
            clearFeedback();
          }}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              (e.nativeEvent.isComposing ||
                composing.current ||
                e.keyCode === 229)
            )
              e.preventDefault();
          }}
        />
        <Button
          variant="outline"
          type="submit"
          aria-label="キャラクターを追加"
          disabled={saving || !characterInput.trim()}
        >
          追加
        </Button>
      </form>
      <div role={message ? 'status' : undefined} className="metadata-status">
        {message}
      </div>
      {error && (
        <div className="metadata-error" role="alert">
          <span>{error}</span>
          {retry && (
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => {
                void save(retry);
              }}
            >
              保存を再試行
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
