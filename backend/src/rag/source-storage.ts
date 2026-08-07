import type { AppConfig } from '../shared/config';

export interface StoredObject {
  readonly path: string;
  readonly bytes: number;
  readonly mimeType: string;
}

export interface SourceStorage {
  put(path: string, body: Uint8Array, mimeType: string): Promise<StoredObject>;
  get(path: string): Promise<Uint8Array>;
  remove(path: string): Promise<void>;
  signedUrl(path: string, expiresInSeconds: number): Promise<string>;
}

export const SOURCE_STORAGE = Symbol('SOURCE_STORAGE');

export function storagePath(params: {
  documentId: string;
  versionId: string;
  filename: string;
  organizationId: string | null;
}): string {
  const safeFilename = params.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'source';
  const prefix = params.organizationId
    ? `rag/organizations/${params.organizationId}`
    : 'rag/shared';
  return `${prefix}/${params.documentId}/${params.versionId}/${safeFilename}`;
}

export class SupabaseSourceStorage implements SourceStorage {
  constructor(private readonly config: AppConfig) {}

  async put(path: string, body: Uint8Array, mimeType: string): Promise<StoredObject> {
    const response = await this.request(
      `/storage/v1/object/${this.config.rag.storage.bucket}/${path}`,
      {
        method: 'POST',
        headers: { 'content-type': mimeType, 'x-upsert': 'false' },
        body,
      },
    );
    if (!response.ok) throw new Error(`Supabase Storage upload failed with ${response.status}`);
    return { path, bytes: body.byteLength, mimeType };
  }

  async get(path: string): Promise<Uint8Array> {
    const response = await this.request(
      `/storage/v1/object/${this.config.rag.storage.bucket}/${path}`,
      {
        method: 'GET',
      },
    );
    if (!response.ok) throw new Error(`Supabase Storage download failed with ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async remove(path: string): Promise<void> {
    const response = await this.request(`/storage/v1/object/${this.config.rag.storage.bucket}`, {
      method: 'DELETE',
      body: JSON.stringify({ prefixes: [path] }),
    });
    if (!response.ok) throw new Error(`Supabase Storage delete failed with ${response.status}`);
  }

  async signedUrl(path: string, expiresInSeconds: number): Promise<string> {
    const response = await this.request(
      `/storage/v1/object/sign/${this.config.rag.storage.bucket}/${path}`,
      { method: 'POST', body: JSON.stringify({ expiresIn: expiresInSeconds }) },
    );
    if (!response.ok) throw new Error(`Supabase Storage signed URL failed with ${response.status}`);
    const body = (await response.json()) as { signedURL?: string };
    if (!body.signedURL) throw new Error('Supabase Storage returned no signed URL');
    return body.signedURL;
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.config.database.serviceRoleKey}`);
    headers.set('apikey', this.config.database.serviceRoleKey);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    return fetch(`${this.config.supabase.projectUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.config.openRouter.timeoutMs),
    });
  }
}
