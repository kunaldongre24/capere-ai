import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../shared/config';
import { DatabaseService, type OrgRole } from '../../shared/database';
import { AppException, ErrorCode } from '../../shared/http';
import { getApps, initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { sql } from 'kysely';

type GhlUserContext = {
  userId?: string;
  companyId?: string;
  role?: string;
  type?: string;
  activeLocation?: string;
  userName?: string;
  email?: string;
  iat?: number;
  exp?: number;
};

type SupabaseGenerateLinkResponse = {
  id?: string;
  email?: string;
  hashed_token?: string;
  user?: { id?: string; email?: string };
  msg?: string;
  error_description?: string;
};

export function decryptGhlSsoData(encryptedData: string, sharedSecret: string): GhlUserContext {
  try {
    // HighLevel uses CryptoJS/OpenSSL salted AES-256-CBC. This is the
    // reference algorithm published in their Marketplace app template.
    const raw = Buffer.from(encryptedData, 'base64');
    if (raw.length <= 16 || raw.subarray(0, 8).toString('utf8') !== 'Salted__') {
      throw new Error('Encrypted context is not OpenSSL salted data');
    }
    const salt = raw.subarray(8, 16);
    const cipherText = raw.subarray(16);
    const secret = Buffer.from(sharedSecret, 'utf8');
    let material = Buffer.alloc(0);
    let previous = Buffer.alloc(0);
    while (material.length < 48) {
      previous = createHash('md5').update(Buffer.concat([previous, secret, salt])).digest();
      material = Buffer.concat([material, previous]);
    }
    const decipher = createDecipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48));
    const plaintext = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
    const context = JSON.parse(plaintext) as GhlUserContext;
    if (!context || typeof context !== 'object') throw new Error('Invalid user context');
    return context;
  } catch {
    throw AppException.unauthorized(ErrorCode.INVALID_TOKEN, 'GoHighLevel session context could not be verified');
  }
}

@Injectable()
export class GhlSsoService {
  static readonly FIREBASE_SESSION_MS = 8 * 60 * 60 * 1000;
  private readonly logger = new Logger(GhlSsoService.name);

  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async exchange(encryptedData: string) {
    if (!this.config.ghl.ssoKey) {
      throw AppException.serviceUnavailable(
        ErrorCode.SERVICE_UNAVAILABLE,
        'GoHighLevel SSO is not configured',
      );
    }

    const context = decryptGhlSsoData(encryptedData, this.config.ghl.ssoKey);
    const locationId = this.requiredString(context.activeLocation);
    const email = this.requiredString(context.email).toLowerCase();
    const ghlUserId = this.requiredString(context.userId);

    if (!locationId || !email || !ghlUserId || !email.includes('@')) {
      throw AppException.unauthorized(
        ErrorCode.INVALID_TOKEN,
        'GoHighLevel did not provide valid user and location context',
      );
    }

    // Future-install callbacks are delivered by GoHighLevel independently of
    // the embedded page load. The iframe can therefore reach SSO a moment
    // before the callback has committed the location and integration rows.
    // Allow that normal propagation window to settle before rejecting access.
    let location: { organization_id: string; status: string } | undefined;
    for (let attempt = 0; attempt < 4 && !location; attempt += 1) {
      location = await this.database.db
        .selectFrom('capere.ghl_locations as l')
        .innerJoin('capere.organizations as o', 'o.id', 'l.organization_id')
        .innerJoin('capere.integrations as i', (join) =>
          join
            .onRef('i.organization_id', '=', 'l.organization_id')
            .onRef('i.ghl_location_id', '=', 'l.id')
            .on('i.provider', '=', 'go_high_level')
            .on('i.status', '=', 'connected'),
        )
        .select(['l.organization_id', 'o.status'])
        .where('l.ghl_location_id', '=', locationId)
        .where('o.status', '=', 'active')
        .executeTakeFirst();
      if (!location && attempt < 3) await new Promise((resolve) => setTimeout(resolve, 750));
    }

    if (!location) {
      this.logger.warn({ ghlLocationId: locationId }, 'GHL SSO location is not connected');
      throw AppException.forbidden(
        ErrorCode.INTEGRATION_NOT_CONNECTED,
        'This GoHighLevel sub-account is not connected to Capere',
      );
    }

    if (this.config.identity.provider === 'firebase') {
      return this.exchangeFirebase(location.organization_id, email, context.userName, ghlUserId, context.role);
    }

    const generated = await this.generateMagicLink(email, context.userName, ghlUserId);
    // GoTrue currently returns the generated user fields at the top level.
    // Keep the nested fallback for compatibility with older/self-hosted builds.
    const userId = generated.id ?? generated.user?.id;
    const tokenHash = generated.hashed_token;
    if (!userId || !tokenHash) {
      this.logger.error('Supabase did not return a user and hashed token for GHL SSO');
      throw AppException.serviceUnavailable(
        ErrorCode.SERVICE_UNAVAILABLE,
        'Capere could not create an embedded session',
      );
    }

    const role = this.roleFor(context.role);
    await this.database.transaction(async (trx) => {
      await trx
        .insertInto('capere.users')
        .values({
          id: userId,
          email,
          full_name: this.requiredString(context.userName) || null,
          avatar_url: null,
          last_seen_at: new Date(),
        })
        .onConflict((conflict) =>
          conflict.column('id').doUpdateSet({
            email,
            full_name: this.requiredString(context.userName) || null,
            last_seen_at: new Date(),
            updated_at: new Date(),
          }),
        )
        .execute();

      // A verified GHL user may enter the organization associated with the
      // verified active location. Existing Capere roles are never overwritten.
      await trx
        .insertInto('capere.organization_members')
        .values({
          organization_id: location.organization_id,
          user_id: userId,
          role,
          invited_by: null,
        })
        .onConflict((conflict) => conflict.columns(['organization_id', 'user_id']).doNothing())
        .execute();
    });

    return { tokenHash, organizationId: location.organization_id };
  }

  async createFirebaseSession(idToken: string) {
    if (this.config.identity.provider !== 'firebase') {
      throw AppException.serviceUnavailable(
        ErrorCode.SERVICE_UNAVAILABLE,
        'Firebase authentication is not configured',
      );
    }
    const auth = this.firebaseAuth();
    try {
      const decoded = await auth.verifyIdToken(idToken, true);
      if (!decoded.auth_time || Date.now() / 1000 - decoded.auth_time > 5 * 60) {
        throw new Error('Firebase sign-in is no longer recent');
      }
      const sessionCookie = await auth.createSessionCookie(idToken, {
        expiresIn: GhlSsoService.FIREBASE_SESSION_MS,
      });
      return {
        sessionCookie,
        expiresInSeconds: GhlSsoService.FIREBASE_SESSION_MS / 1000,
      };
    } catch (error) {
      this.logger.warn(
        `Firebase session creation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw AppException.unauthorized(
        ErrorCode.INVALID_TOKEN,
        'Firebase identity token could not be verified',
      );
    }
  }

  private async exchangeFirebase(
    organizationId: string,
    email: string,
    fullName: string | undefined,
    ghlUserId: string,
    ghlRole: string | undefined,
  ) {
    const auth = this.firebaseAuth();
    const existing = await this.database.db
      .selectFrom('capere.users')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();
    const firebaseUser = existing
      ? undefined
      : await auth.getUserByEmail(email).catch((error: unknown) => {
          if (this.firebaseUserNotFound(error)) return undefined;
          throw error;
        });
    const uid = existing?.id ?? firebaseUser?.uid ?? randomUUID();
    try {
      await auth.getUser(uid);
      await auth.updateUser(uid, { email, displayName: fullName || undefined, disabled: false });
    } catch (error) {
      if (!this.firebaseUserNotFound(error)) throw error;
      await auth.createUser({ uid, email, displayName: fullName || undefined, emailVerified: true });
    }
    const role = this.roleFor(ghlRole);
    await this.database.transaction(async (trx) => {
      await sql`INSERT INTO auth.users (id, email) VALUES (${uid}::uuid, ${email}) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`.execute(trx);
      await trx.insertInto('capere.users').values({ id: uid, email, full_name: fullName || null, avatar_url: null, last_seen_at: new Date() }).onConflict((conflict) => conflict.column('id').doUpdateSet({ email, full_name: fullName || null, last_seen_at: new Date(), updated_at: new Date() })).execute();
      await trx.insertInto('capere.organization_members').values({ organization_id: organizationId, user_id: uid, role, invited_by: null }).onConflict((conflict) => conflict.columns(['organization_id', 'user_id']).doNothing()).execute();
    });
    const customToken = await auth.createCustomToken(uid, { ghl_user_id: ghlUserId });
    return { customToken, organizationId };
  }

  private firebaseAuth() {
    if (!getApps().length) {
      initializeApp({
        credential: applicationDefault(),
        projectId: this.config.identity.firebaseProjectId,
      });
    }
    return getAuth();
  }

  private firebaseUserNotFound(error: unknown): boolean {
    return (error as { code?: string })?.code === 'auth/user-not-found';
  }


  private async generateMagicLink(email: string, fullName?: string, ghlUserId?: string) {
    const url = `${this.config.supabase.projectUrl.replace(/\/$/, '')}/auth/v1/admin/generate_link`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          apikey: this.config.database.serviceRoleKey,
          authorization: `Bearer ${this.config.database.serviceRoleKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'magiclink',
          email,
          options: { data: { full_name: fullName ?? '', ghl_user_id: ghlUserId ?? '' } },
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw AppException.serviceUnavailable(
        ErrorCode.SERVICE_UNAVAILABLE,
        'Authentication service is temporarily unavailable',
      );
    }
    const body = (await response.json().catch(() => ({}))) as SupabaseGenerateLinkResponse;
    if (!response.ok) {
      this.logger.error(`Supabase generate_link failed with HTTP ${response.status}`);
      throw AppException.serviceUnavailable(
        ErrorCode.SERVICE_UNAVAILABLE,
        body.msg ?? body.error_description ?? 'Authentication service rejected the SSO exchange',
      );
    }
    return body;
  }

  private roleFor(ghlRole?: string): OrgRole {
    return ghlRole?.toLowerCase() === 'admin' ? 'office_manager' : 'marketing_manager';
  }

  private requiredString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }
}
