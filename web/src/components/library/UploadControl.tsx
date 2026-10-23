import { type RefObject, useRef } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export function UploadControl({
  busy,
  onUpload,
  uploadInput,
}: {
  busy: boolean;
  onUpload: (file: File) => void;
  uploadInput?: RefObject<HTMLInputElement | null>;
}) {
  const localInput = useRef<HTMLInputElement>(null);
  const input = uploadInput ?? localInput;

  return (
    <section className="heading">
      <h1>ライブラリ</h1>
      <Button
        variant="default"
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        ＋ アップロード
      </Button>
      <Input
        ref={input}
        className="visually-hidden"
        tabIndex={-1}
        type="file"
        aria-label="アップロードするファイル"
        accept="image/*,video/*,audio/*,application/pdf"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
          e.target.value = '';
        }}
      />
    </section>
  );
}
