import { type RefObject, useRef } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export function UploadControl({
  busy,
  onUpload,
  uploadInput,
}: {
  busy: boolean;
  onUpload: (files: File[]) => void;
  uploadInput?: RefObject<HTMLInputElement | null>;
}) {
  const localInput = useRef<HTMLInputElement>(null);
  const input = uploadInput ?? localInput;

  return (
    <>
      <Button
        aria-label="＋ アップロード"
        variant="default"
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        <span aria-hidden="true">＋</span>
        <span className="upload-label">アップロード</span>
      </Button>
      <Input
        ref={input}
        className="visually-hidden"
        tabIndex={-1}
        type="file"
        multiple
        aria-label="アップロードするファイル"
        accept="image/*,video/*,audio/*,application/pdf"
        disabled={busy}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onUpload(files);
          e.target.value = '';
        }}
      />
    </>
  );
}
