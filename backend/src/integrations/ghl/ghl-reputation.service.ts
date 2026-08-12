import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../shared/database';
import { GhlAdapter } from './ghl.adapter';
import { GhlTokenService } from './ghl-token.service';
import { GooglePlacesService, type GooglePlaceProfile } from '../google/google-places.service';

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
  accessStatus: 'available' | 'permission_required' | 'temporarily_unavailable';
  profileConnectionConfirmed: boolean;
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
  responseRate: number;
  ratingDistribution: Record<'1' | '2' | '3' | '4' | '5', number>;
  monthlyTrend: Array<{ month: string; count: number; averageRating: number }>;
  business?: {
    name: string | null;
    website: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    postalCode: string | null;
    timezone: string | null;
    logoUrl: string | null;
    googlePlacesId: string | null;
    social: Record<string, string>;
  };
  googleProfile?: GooglePlaceProfile;
  message?: string;
};

@Injectable()
export class GhlReputationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly adapter: GhlAdapter,
    private readonly tokens: GhlTokenService,
    private readonly places: GooglePlacesService,
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
      const location = await this.adapter.getLocation(credentials, integration.account_id);
      const business = {
        name: location.name ?? integration.account_name ?? null,
        website: location.website ?? null,
        email: location.email ?? null,
        phone: location.phone ?? null,
        address: location.address ?? null,
        city: location.city ?? null,
        state: location.state ?? null,
        country: location.country ?? null,
        postalCode: location.postalCode ?? null,
        timezone: location.timezone ?? null,
        logoUrl: location.logoUrl ?? null,
        googlePlacesId: location.googlePlacesId ?? null,
        social: Object.fromEntries(
          Object.entries(location.social ?? {}).filter(([key, value]) =>
            key.toLowerCase() !== 'googleplacesid' && key.toLowerCase() !== 'google_place_id' && Boolean(value),
          ),
        ),
      };
      const googleProfile = location.googlePlacesId
        ? await this.places.profile(location.googlePlacesId)
        : undefined;
      let body: GhlReviewsResponse;
      try {
        body = await this.adapter.getJson<GhlReviewsResponse>(
          credentials,
          '/reputation/reviews',
          { locationId: integration.account_id, limit: 100, skip: 0 },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const permissionRequired = message.includes('401') || message.includes('403');
        return {
          ...this.empty(
            true,
            permissionRequired
              ? 'The public business profile is available. Capere still needs GoHighLevel reputation permission to read review data.'
              : 'Business details are available, but review data is temporarily unavailable from GoHighLevel.',
            integration.account_id,
            integration.account_name,
            permissionRequired ? 'permission_required' : 'temporarily_unavailable',
          ),
          business,
          googleProfile,
          profileConnectionConfirmed: Boolean(googleProfile?.available),
        };
      }
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
      const ratingDistribution: GhlReputationSummary['ratingDistribution'] = {
        '1': 0,
        '2': 0,
        '3': 0,
        '4': 0,
        '5': 0,
      };
      for (const review of rated) {
        const rounded = String(Math.min(5, Math.max(1, Math.round(review.rating)))) as keyof typeof ratingDistribution;
        ratingDistribution[rounded] += 1;
      }
      const months = new Map<string, { count: number; ratings: number[] }>();
      for (const review of reviews) {
        if (!review.createdAt) continue;
        const date = new Date(review.createdAt);
        if (Number.isNaN(date.getTime())) continue;
        const month = date.toISOString().slice(0, 7);
        const current = months.get(month) ?? { count: 0, ratings: [] };
        current.count += 1;
        if (review.rating > 0) current.ratings.push(review.rating);
        months.set(month, current);
      }
      const monthlyTrend = [...months.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-12)
        .map(([month, value]) => ({
          month,
          count: value.count,
          averageRating: value.ratings.length
            ? value.ratings.reduce((sum, rating) => sum + rating, 0) / value.ratings.length
            : 0,
        }));
      const reportedTotal = Number(body.total ?? body.meta?.total ?? reviews.length);
      return {
        connected: true,
        dataAvailable: reviews.length > 0,
        source: 'go_high_level',
        accessStatus: 'available',
        profileConnectionConfirmed: Boolean(googleProfile?.available) || reviews.length > 0,
        locationId: integration.account_id,
        locationName: integration.account_name,
        reviews,
        reviewCount: Number.isFinite(reportedTotal) ? reportedTotal : reviews.length,
        averageRating: rated.length
          ? rated.reduce((sum, review) => sum + review.rating, 0) / rated.length
          : 0,
        unanswered: reviews.filter((review) => !review.replied).length,
        responseRate: reviews.length
          ? reviews.filter((review) => review.replied).length / reviews.length
          : 0,
        ratingDistribution,
        monthlyTrend,
        business,
        googleProfile,
        message: reviews.length
          ? undefined
          : 'GoHighLevel is connected, but no Google reviews are available for this location yet.',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const permissionRequired = message.includes('401') || message.includes('403');
      return this.empty(
        true,
        permissionRequired
          ? 'The GoHighLevel account is connected, but review data is unavailable until the agency grants Capere reputation permission. Public listing details may still be available.'
          : 'Review data is temporarily unavailable from GoHighLevel.',
        integration.account_id,
        integration.account_name,
        permissionRequired ? 'permission_required' : 'temporarily_unavailable',
      );
    }
  }

  private empty(
    connected: boolean,
    message: string,
    locationId?: string,
    locationName?: string | null,
    accessStatus: GhlReputationSummary['accessStatus'] = 'temporarily_unavailable',
  ): GhlReputationSummary {
    return {
      connected,
      dataAvailable: false,
      source: 'go_high_level',
      accessStatus,
      profileConnectionConfirmed: false,
      locationId,
      locationName,
      reviews: [],
      reviewCount: 0,
      averageRating: 0,
      unanswered: 0,
      responseRate: 0,
      ratingDistribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
      monthlyTrend: [],
      message,
    };
  }
}
