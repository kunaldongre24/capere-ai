import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../shared/config';
import { providerFetch, readJson } from '../provider-adapter';

interface DataForSeoResponse<T> {
  tasks?: Array<{ id?: string; status_code: number; result?: T[]; cost?: number }>;
}

@Injectable()
export class DataForSeoAdapter {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async postTask<T>(path: string, request: unknown): Promise<DataForSeoResponse<T>> {
    const response = await providerFetch(
      'data_for_seo',
      `${this.config.dataForSeo.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.config.dataForSeo.login}:${this.config.dataForSeo.password}`).toString('base64')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify([request]),
      },
    );
    return readJson<DataForSeoResponse<T>>('data_for_seo', response);
  }
}
