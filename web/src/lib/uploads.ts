export const uploadPartSize = 8 * 1024 * 1024;

export type UploadTask = {
  id: string;
  groupId?: string;
  file: File;
  state: 'waiting' | 'uploading' | 'completed' | 'failed';
  progress: number;
  session?: { upload_id: string; asset_id: string };
};

type Request = (path: string, options?: RequestInit) => Promise<unknown>;

export async function filterDuplicateUploadFiles(
  files: File[],
): Promise<File[]> {
  const byName = new Map<string, File[]>();
  for (const file of files) {
    const group = byName.get(file.name) ?? [];
    group.push(file);
    byName.set(file.name, group);
  }
  const hashes = new Map<File, Promise<string | undefined>>();
  const hash = (file: File) => {
    let result = hashes.get(file);
    if (!result) {
      result = (async () => {
        try {
          const digest = await crypto.subtle.digest(
            'SHA-256',
            await file.arrayBuffer(),
          );
          return Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join('');
        } catch {
          // Keep files when their contents cannot be verified locally.
          return undefined;
        }
      })();
      hashes.set(file, result);
    }
    return result;
  };
  const retained: File[] = [];
  for (const file of files) {
    const match = file.name.match(
      /^(.*?)\s*(?:\([+-]?\d+\)|（[+-]?\d+）)(\.[^.]*)?$/u,
    );
    const originals = match
      ? (byName.get(`${match[1]}${match[2] ?? ''}`) ?? []).filter(
          (original) => original.size === file.size,
        )
      : [];
    let duplicate = false;
    if (originals.length) {
      const candidateHash = await hash(file);
      if (candidateHash !== undefined) {
        for (const original of originals) {
          if ((await hash(original)) === candidateHash) {
            duplicate = true;
            break;
          }
        }
      }
    }
    if (!duplicate) retained.push(file);
  }
  return retained;
}

function send(
  path: string,
  body: Blob,
  csrf: string,
  progress: (bytes: number) => void,
) {
  return new Promise<{ asset_id: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', path);
    xhr.timeout = 10 * 60 * 1000;
    xhr.setRequestHeader('X-CSRF-Token', csrf);
    xhr.upload.onprogress = (event) => progress(event.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          resolve({ asset_id: '' });
        }
      } else reject(new Error('アップロードに失敗しました'));
    };
    xhr.onerror = xhr.ontimeout = () => reject(new Error('通信に失敗しました'));
    xhr.send(body);
  });
}

export async function uploadFile(
  task: UploadTask,
  csrf: string,
  request: Request,
  progress: (value: number) => void,
) {
  const file = task.file;
  task.session ??= (await request('/api/v1/uploads', {
    method: 'POST',
    headers: { 'Idempotency-Key': task.id },
    body: JSON.stringify({
      group_id: task.groupId,
      filename: file.name,
      mime_type: file.type || 'application/octet-stream',
      size_bytes: file.size,
    }),
  })) as NonNullable<UploadTask['session']>;
  const session = task.session;
  if (!session) throw new Error('アップロードを開始できませんでした');
  const base = `/api/v1/uploads/${session.upload_id}`;
  if (file.size <= uploadPartSize) {
    const result = await send(`${base}/content`, file, csrf, (bytes) =>
      progress(
        file.size ? Math.min(99, Math.floor((bytes / file.size) * 100)) : 0,
      ),
    );
    if (result.asset_id) session.asset_id = result.asset_id;
  } else {
    const status = (await request(`${base}/parts`)) as {
      state: string;
      part_size: number;
      parts: { part_number: number }[];
    };
    if (status.state === 'completed') {
      const result = (await request(base)) as { asset_id: string };
      session.asset_id = result.asset_id;
    } else {
      const received = new Set<number>(
        status.parts.map((part: { part_number: number }) => part.part_number),
      );
      let sent = 0;
      for (
        let number = 0, offset = 0;
        offset < file.size;
        number++, offset += uploadPartSize
      ) {
        const part = file.slice(offset, offset + uploadPartSize);
        if (!received.has(number)) {
          let failure: unknown;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await send(`${base}/parts/${number}`, part, csrf, (bytes) =>
                progress(
                  Math.min(99, Math.floor(((sent + bytes) / file.size) * 100)),
                ),
              );
              failure = undefined;
              break;
            } catch (error) {
              failure = error;
              if (attempt < 2)
                await new Promise((resolve) =>
                  setTimeout(resolve, 500 * 2 ** attempt),
                );
            }
          }
          if (failure) throw failure;
        }
        sent += part.size;
        progress(Math.min(99, Math.floor((sent / file.size) * 100)));
      }
      const result = (await request(`${base}/complete`, {
        method: 'POST',
      })) as { asset_id: string };
      session.asset_id = result.asset_id;
    }
  }
  progress(100);
  return session.asset_id;
}
