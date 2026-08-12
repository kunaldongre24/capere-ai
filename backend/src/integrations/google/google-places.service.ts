import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../shared/config';

type PlaceReview = {
  name?: string;
  rating?: number;
  relativePublishTimeDescription?: string;
  publishTime?: string;
  text?: { text?: string; languageCode?: string };
  authorAttribution?: { displayName?: string; uri?: string; photoUri?: string };
};

type PlaceDetails = {
  id?: string;
  displayName?: { text?: string; languageCode?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  businessStatus?: string;
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
  types?: string[];
  rating?: number;
  userRatingCount?: number;
  regularOpeningHours?: { openNow?: boolean; weekdayDescriptions?: string[] };
  currentOpeningHours?: { openNow?: boolean; weekdayDescriptions?: string[] };
  editorialSummary?: { text?: string; languageCode?: string };
  photos?: Array<{ name?: string; widthPx?: number; heightPx?: number; authorAttributions?: unknown[] }>;
  reviews?: PlaceReview[];
};

export type GooglePlaceProfile = {
  available: boolean;
  setupRequired: boolean;
  placeId: string;
  name: string | null;
  description: string | null;
  primaryCategory: string | null;
  categories: string[];
  address: string | null;
  phone: string | null;
  website: string | null;
  mapsUrl: string | null;
  businessStatus: string | null;
  openNow: boolean | null;
  openingHours: string[];
  rating: number;
  reviewCount: number;
  photos: Array<{ name: string; width: number | null; height: number | null }>;
  reviews: Array<{ id: string; rating: number; author: string | null; comment: string | null; publishedAt: string | null; relativeTime: string | null; authorPhoto: string | null }>;
  message?: string;
};

@Injectable()
export class GooglePlacesService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async profile(placeId: string): Promise<GooglePlaceProfile> {
    if (!this.config.google.placesApiKey)
      return this.empty(placeId, true, 'Google Places API is not configured by the Capere administrator.');
    const fields = [
      'id','displayName','formattedAddress','nationalPhoneNumber','internationalPhoneNumber',
      'websiteUri','googleMapsUri','businessStatus','primaryType','primaryTypeDisplayName','types',
      'rating','userRatingCount','regularOpeningHours','currentOpeningHours','editorialSummary','photos','reviews',
    ].join(',');
    let response: Response;
    try {
      response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
        headers: { 'X-Goog-Api-Key': this.config.google.placesApiKey, 'X-Goog-FieldMask': fields },
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      return this.empty(placeId, false, 'Google Business Profile details are temporarily unavailable.');
    }
    if (!response.ok) {
      return this.empty(
        placeId,
        response.status === 403,
        response.status === 403
          ? 'Google Places API access needs to be enabled for the Capere project.'
          : 'Google could not return this business listing.',
      );
    }
    const place = (await response.json()) as PlaceDetails;
    const hours = place.currentOpeningHours ?? place.regularOpeningHours;
    return {
      available: true,
      setupRequired: false,
      placeId,
      name: place.displayName?.text ?? null,
      description: place.editorialSummary?.text ?? null,
      primaryCategory: place.primaryTypeDisplayName?.text ?? this.words(place.primaryType),
      categories: (place.types ?? []).map((type) => this.words(type)).filter(Boolean) as string[],
      address: place.formattedAddress ?? null,
      phone: place.nationalPhoneNumber ?? place.internationalPhoneNumber ?? null,
      website: place.websiteUri ?? null,
      mapsUrl: place.googleMapsUri ?? null,
      businessStatus: this.words(place.businessStatus),
      openNow: typeof hours?.openNow === 'boolean' ? hours.openNow : null,
      openingHours: hours?.weekdayDescriptions ?? [],
      rating: Number(place.rating ?? 0),
      reviewCount: Number(place.userRatingCount ?? 0),
      photos: (place.photos ?? []).filter((photo) => Boolean(photo.name)).slice(0, 8).map((photo) => ({
        name: photo.name!, width: photo.widthPx ?? null, height: photo.heightPx ?? null,
      })),
      reviews: (place.reviews ?? []).map((review, index) => ({
        id: review.name ?? `${placeId}:${index}`,
        rating: Number(review.rating ?? 0),
        author: review.authorAttribution?.displayName ?? null,
        comment: review.text?.text ?? null,
        publishedAt: review.publishTime ?? null,
        relativeTime: review.relativePublishTimeDescription ?? null,
        authorPhoto: review.authorAttribution?.photoUri ?? null,
      })),
    };
  }

  async photo(name: string, maxWidth = 1200): Promise<Response> {
    if (!this.config.google.placesApiKey || !/^places\/[^/]+\/photos\/[^/]+$/.test(name))
      return new Response(null, { status: 404 });
    const metadata = await fetch(
      `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${Math.min(1600, Math.max(200, maxWidth))}&skipHttpRedirect=true`,
      { headers: { 'X-Goog-Api-Key': this.config.google.placesApiKey }, signal: AbortSignal.timeout(12_000) },
    );
    if (!metadata.ok) return new Response(null, { status: metadata.status });
    const body = (await metadata.json()) as { photoUri?: string };
    if (!body.photoUri) return new Response(null, { status: 404 });
    return fetch(body.photoUri, { signal: AbortSignal.timeout(12_000) });
  }

  private empty(placeId: string, setupRequired: boolean, message: string): GooglePlaceProfile {
    return { available:false,setupRequired,placeId,name:null,description:null,primaryCategory:null,categories:[],address:null,phone:null,website:null,mapsUrl:null,businessStatus:null,openNow:null,openingHours:[],rating:0,reviewCount:0,photos:[],reviews:[],message };
  }
  private words(value?: string): string | null {
    return value ? value.toLowerCase().replaceAll('_',' ').replace(/\b\w/g,(letter)=>letter.toUpperCase()) : null;
  }
}
