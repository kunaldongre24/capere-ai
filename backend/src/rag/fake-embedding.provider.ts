import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { EmbeddingProvider, EmbeddingResult } from './embedding.port';

@Injectable()
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake';

  constructor(private readonly dimensions = 32) {}

  async embed(inputs: readonly string[]): Promise<EmbeddingResult> {
    return {
      model: 'fake-embedding',
      dimensions: this.dimensions,
      vectors: inputs.map((input) => {
        const digest = createHash('sha256').update(input).digest();
        return Array.from(
          { length: this.dimensions },
          (_, index) => (digest[index % digest.length] / 255) * 2 - 1,
        );
      }),
      usage: {
        promptTokens: inputs.reduce((total, input) => total + Math.ceil(input.length / 4), 0),
        totalTokens: inputs.reduce((total, input) => total + Math.ceil(input.length / 4), 0),
        costMicroUsd: 0,
      },
    };
  }
}
