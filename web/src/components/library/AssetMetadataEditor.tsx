import { useEffect, useRef, useState } from 'react';
import {
  type Asset,
  type AssetChanges,
  type Rating,
  ratingLabel,
  ratings,
} from '../../lib/assets';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { NativeSelect } from '../ui/native-select';

export function AssetMetadataEditor({
  asset,
  onSave,
  onSearchTag,
  onSearchCharacter,
  readOnly = false,
}: {
  readOnly?: boolean;
  onSearchTag: (tag: string) => void;
  onSearchCharacter: (character: string) => void;
  asset: Asset;
  onSave: (changes: AssetChanges) => Promise<Asset>;
}) {
  const [rating, setRating] = useState(asset.rating ?? 'unrated');
  const [filename, setFilename] = useState(asset.filename);
  const [savedTags, setTags] = useState(asset.tags);
  const tags = readOnly ? asset.tags : savedTags;
  const [tagInput, setTagInput] = useState('');
  const [savedCharacters, setCharacters] = useState(asset.characters ?? []);
  const characters = readOnly ? (asset.characters ?? []) : savedCharacters;
  const [characterInput, setCharacterInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState<AssetChanges | null>(null);
  const queue = useRef(Promise.resolve());
  const pending = useRef(0);
  const versions = useRef({ filename: 0, rating: 0, tags: 0, characters: 0 });
  const failures = useRef(
    new Map<keyof typeof versions.current, AssetChanges>(),
  );
  const savedFilename = useRef(asset.filename);
  const pendingFilename = useRef<string | null>(null);
  const composing = useRef(false);
  const bytes = (value: string) => new TextEncoder().encode(value).length;

  useEffect(() => {
    if (pending.current === 0 && !failures.current.has('rating'))
      setRating(asset.rating ?? 'unrated');
  }, [asset.rating]);

  async function save(changes: AssetChanges) {
    const submittedTag = tagInput;
    const submittedCharacter = characterInput;
    const fields = Object.keys(changes) as (keyof typeof versions.current)[];
    const snapshot = { ...versions.current };
    for (const field of fields) snapshot[field] = ++versions.current[field];
    if (changes.rating !== undefined) setRating(changes.rating);
    if (changes.filename !== undefined)
      pendingFilename.current = changes.filename;
    if (changes.tags !== undefined) setTags(changes.tags);
    if (changes.characters !== undefined) setCharacters(changes.characters);
    pending.current += 1;
    setSaving(true);
    if (failures.current.size === 0) setError('');
    setMessage('保存中…');
    const execute = async () => {
      try {
        const updated = await onSave(changes);
        savedFilename.current = updated.filename;
        if (
          changes.filename !== undefined &&
          snapshot.filename === versions.current.filename
        )
          setFilename(updated.filename);
        if (
          changes.rating !== undefined &&
          snapshot.rating === versions.current.rating
        )
          setRating(updated.rating ?? 'unrated');
        if (changes.tags && snapshot.tags === versions.current.tags) {
          setTags(updated.tags);
          setTagInput((current) => (current === submittedTag ? '' : current));
        }
        if (
          changes.characters &&
          snapshot.characters === versions.current.characters
        ) {
          setCharacters(updated.characters ?? []);
          setCharacterInput((current) =>
            current === submittedCharacter ? '' : current,
          );
        }
        for (const field of fields) {
          if (snapshot[field] === versions.current[field])
            failures.current.delete(field);
        }
        const nextRetry = failures.current.values().next().value;
        setRetry(nextRetry ?? null);
        if (nextRetry) setError('保存できませんでした。再試行してください。');
        else {
          setError('');
          setMessage(pending.current > 1 ? '保存中…' : '保存しました');
        }
      } catch {
        for (const field of fields) {
          if (snapshot[field] === versions.current[field])
            failures.current.set(field, changes);
        }
        const nextRetry = failures.current.values().next().value;
        if (nextRetry) {
          setError('保存できませんでした。再試行してください。');
          setRetry(nextRetry);
          setMessage('');
        }
      } finally {
        if (changes.filename === pendingFilename.current)
          pendingFilename.current = null;
        pending.current -= 1;
        setSaving(pending.current > 0);
      }
    };
    queue.current = queue.current.then(execute);
    await queue.current;
  }

  function saveFilename() {
    if (
      composing.current ||
      filename === (pendingFilename.current ?? savedFilename.current)
    )
      return;
    if (!filename.trim() || bytes(filename) > 1024) {
      setError('ファイル名は空白以外を含む1024バイト以内で入力してください。');
      if (!failures.current.size) setRetry(null);
      return;
    }
    void save({ filename });
  }

  function addTag() {
    const tag = tagInput.trim();
    if (!tag) return;
    if (tags.includes(tag)) {
      setError('このタグは追加済みです。');
      if (!failures.current.size) setRetry(null);
      return;
    }
    if (bytes(tag) > 256 || tags.length >= 512) {
      setError('タグは1件256バイト以内、合計512件まで追加できます。');
      if (!failures.current.size) setRetry(null);
      return;
    }
    void save({ tags: [...tags, tag] });
  }

  function addCharacter() {
    const character = characterInput.trim();
    if (!character) return;
    if (characters.includes(character)) {
      setError('このキャラクターは追加済みです。');
      if (!failures.current.size) setRetry(null);
      return;
    }
    if (bytes(character) > 256 || characters.length >= 512) {
      setError('キャラクターは1件256バイト以内、合計512件まで追加できます。');
      if (!failures.current.size) setRetry(null);
      return;
    }
    void save({ characters: [...characters, character] });
  }

  function clearFeedback() {
    if (failures.current.size) return;
    setError('');
    setMessage('');
    setRetry(null);
  }

  return (
    <div className="metadata-editor" aria-busy={saving}>
      {!readOnly && (
        <details className="rename-field">
          <summary>名前を変更</summary>
          <Label htmlFor="asset-filename" className="visually-hidden">
            ファイル名
          </Label>
          <Input
            id="asset-filename"
            value={filename}
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
      )}
      <Label htmlFor="asset-rating">コンテンツレーティング</Label>
      <NativeSelect
        id="asset-rating"
        value={rating}
        disabled={readOnly}
        onChange={(event) => {
          void save({ rating: event.target.value as Rating });
        }}
      >
        {ratings.map((value) => (
          <option key={value} value={value}>
            {ratingLabel(value)}
          </option>
        ))}
      </NativeSelect>
      <Label htmlFor={readOnly ? undefined : 'asset-tag-input'}>タグ</Label>
      {tags.length > 0 ? (
        <ul className="tag-chips" aria-label="登録済みタグ">
          {tags.map((tag, index) => (
            <li className="tag-chip" key={tag}>
              <Button
                type="button"
                variant="link"
                className="tag-search-button"
                aria-label={`タグ「${tag}」で検索`}
                onClick={() => onSearchTag(tag)}
              >
                {tag}
              </Button>
              {!readOnly && (
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`タグ「${tag}」を削除`}
                  onClick={() => {
                    void save({ tags: tags.filter((_, i) => i !== index) });
                  }}
                >
                  <span aria-hidden="true">×</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="metadata-hint">タグはありません</p>
      )}
      {!readOnly && (
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
          <Button variant="outline" type="submit" disabled={!tagInput.trim()}>
            追加
          </Button>
        </form>
      )}
      <Label htmlFor={readOnly ? undefined : 'asset-character-input'}>
        キャラクター
      </Label>
      {characters.length > 0 ? (
        <ul className="tag-chips" aria-label="登録済みキャラクター">
          {characters.map((character, index) => (
            <li className="tag-chip" key={character}>
              <Button
                type="button"
                variant="link"
                className="tag-search-button"
                aria-label={`キャラクター「${character}」で検索`}
                onClick={() => onSearchCharacter(character)}
              >
                {character}
              </Button>
              {!readOnly && (
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`キャラクター「${character}」を削除`}
                  onClick={() => {
                    void save({
                      characters: characters.filter((_, i) => i !== index),
                    });
                  }}
                >
                  <span aria-hidden="true">×</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="metadata-hint">キャラクターはありません</p>
      )}
      {!readOnly && (
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
            disabled={!characterInput.trim()}
          >
            追加
          </Button>
        </form>
      )}
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
