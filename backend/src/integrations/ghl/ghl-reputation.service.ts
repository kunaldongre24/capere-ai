import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../shared/database';
import { GhlAdapter } from './ghl.adapter';
import { GhlTokenService } from './ghl-token.service';

type GhlReview = {
  id?: string;
  reviewId?: string;
  rating?: number;
  reviewRating?: number;
  reviewerName?: string;
  reviewer?: { name?: string; displayName?: string };
  reviewText?: string;
  comment?: string;
  reviewDate?: string;
  createdAt?: string;
  updatedAt?: string;
  response?: unknown;
  reply?: unknown;
  source?: string;
};

type GhlReviewsResponse = {
  reviews?: GhlReview[];
  data?: GhlReview[];
  total?: number;
  meta?: { total?: number };
};

export type GhlReputationSummary = {
  connected: boolean;
  dataAvailable: boolean;
  source: 'go_high_level';
  locationId?: string;
  locationName?: string | null;
  reviews: Array<{
    id: string;
    rating: number;
    reviewerName: string | null;
    comment: string | null;
    createdAt: string | null;
    replied: boolean;
    source: string;
  }>;
  reviewCount: number;
  averageRating: number;
  unanswered: number;
  message?: string;
};

@Injectable()
export class GhlReputationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly adapter: GhlAdapter,
    private readonly tokens: GhlTokenService,
  ) {}

  async summary(organizationId: string): Promise<GhlReputationSummary> {
    const integration = await this.database.db
      .selectFrom('capere.integrations')
      .select(['id', 'account_id', 'account_name'])
      .where('organization_id', '=', organizationId)
      .where('provider', '=', 'go_high_level')
      .where('status', '=', 'connected')
      .orderBy('created_at', 'asc')
      .executeTakeFirst();
    if (!integration?.account_id) return this.empty(false, 'GoHighLevel is not connected.');

    try {
      const credentials = await this.tokens.credentials(organizationId, integration.id);
      const body = await this.adapter.getJson<GhlReviewsResponse>(
        credentials,
        '/reputation/reviews',
        { locationId: integration.account_id, limit: 100, skip: 0 },
      );
      const rows = body.reviews ?? body.data ?? [];
      const reviews = rows.map((row, index) => {
        const rating = Number(row.rating ?? row.reviewRating ?? 0);
        const createdAt = row.reviewDate ?? row.createdAt ?? null;
        return {
          id: row.reviewId ?? row.id ?? `${integration.account_id}:${index}`,
          rating: Number.isFinite(rating) ? rating : 0,
          reviewerName: row.reviewerName ?? row.reviewer?.displayName ?? row.reviewer?.name ?? null,
          comment: row.reviewText ?? row.comment ?? null,
          createdAt,
          replied: Boolean(row.response ?? row.reply),
          source: row.source ?? 'Google',
        };
      });
      const rated = reviews.filter((review) => review.rating > 0);
      const reportedTotal = Number(body.total ?? body.meta?.total ?? reviews.length);
      return {
        connected: true,
        dataAvailable: reviews.length > 0,
        source: 'go_high_level',
        locationId: integration.account_id,
        locationName: integration.account_name,
        reviews,
        reviewCount: Number.isFinite(reportedTotal) ? reportedTotal : reviews.length,
        averageRating: rated.length
          ? rated.reduce((sum, review) => sum + review.rating, 0) / rated.length
          : 0,
        unanswered: reviews.filter((review) => !review.replied).length,
        message: reviews.length
          ? undefined
          : 'GoHighLevel is connected, but no Google reviews are available for this location yet.',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return this.empty(
        true,
        message.includes('401') || message.includes('403')
          ? 'Review access needs approval. Ask your agency administrator to update the Capere app installation.'
          : 'Review data is temporarily unavailable from GoHighLevel.',
        integration.account_id,
        integration.account_name,
      );
    }
  }

  private empty(
    connected: boolean,
    message: string,
    locationId?: string,
    locationName?: string | null,
  ): GhlReputationSummary {
    return {
      connected,
      dataAvailable: false,
      source: 'go_high_level',
      locationId,
      locationName,
      reviews: [],
      reviewCount: 0,
      averageRating: 0,
      unanswered: 0,
      message,
    };
  }
}
