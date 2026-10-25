export const uploadPartSize = 8 * 1024 * 1024;

export type UploadTask = {
  id: string;
  file: File;
  state: 'waiting' | 'uploading' | 'completed' | 'failed';
  progress: number;
  session?: { upload_id: string; asset_id: string };
};

type Request = (path: string, options?: RequestInit) => Promise<unknown>;

function send(
  path: string,
  body: Blob,
  csrf: string,
  progress: (bytes: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', path);
    xhr.timeout = 10 * 60 * 1000;
    xhr.setRequestHeader('X-CSRF-Token', csrf);
    xhr.upload.onprogress = (event) => progress(event.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error('アップロードに失敗しました'));
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
      filename: file.name,
      mime_type: file.type || 'application/octet-stream',
      size_bytes: file.size,
    }),
  })) as NonNullable<UploadTask['session']>;
  const session = task.session;
  if (!session) throw new Error('アップロードを開始できませんでした');
  const base = `/api/v1/uploads/${session.upload_id}`;
  if (file.size <= uploadPartSize) {
    await send(`${base}/content`, file, csrf, (bytes) =>
      progress(
        file.size ? Math.min(99, Math.floor((bytes / file.size) * 100)) : 0,
      ),
    );
  } else {
    const status = (await request(`${base}/parts`)) as {
      state: string;
      part_size: number;
      parts: { part_number: number }[];
    };
    if (status.state !== 'completed') {
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
      await request(`${base}/complete`, { method: 'POST' });
    }
  }
  progress(100);
  return session.asset_id;
}
