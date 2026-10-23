import type { Mode } from '../../lib/assets';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { NativeSelect } from '../ui/native-select';

export function SearchForm({
  query,
  mode,
  searching,
  onQueryChange,
  onModeChange,
  onSearch,
}: {
  query: string;
  mode: Mode;
  searching: boolean;
  onQueryChange: (query: string) => void;
  onModeChange: (mode: Mode) => void;
  onSearch: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: The search landmark is also a submitting form.
    <form
      className="search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch();
      }}
    >
      <div className="search-field">
        <span aria-hidden="true">⌕</span>
        <Input
          type="search"
          aria-label="検索クエリ"
          placeholder="ファイルを検索"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
      </div>
      <NativeSelect
        aria-label="検索方法"
        value={mode}
        onChange={(e) => onModeChange(e.target.value as Mode)}
      >
        <option value="keyword">キーワード</option>
        <option value="semantic">意味</option>
        <option value="hybrid">キーワード＋意味</option>
      </NativeSelect>
      <Button variant="outline" type="submit" disabled={searching}>
        {searching ? '検索中…' : '検索'}
      </Button>
    </form>
  );
}
