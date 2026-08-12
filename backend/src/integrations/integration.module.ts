import { Module } from '@nestjs/common';
import { GhlAdapter } from './ghl/ghl.adapter';
import { GhlWebhookController } from './ghl/ghl-webhook.controller';
import { GhlWebhookService } from './ghl/ghl-webhook.service';
import { GhlOauthController } from './ghl/ghl-oauth.controller';
import { GhlOauthService } from './ghl/ghl-oauth.service';
import { GhlSsoController } from './ghl/ghl-sso.controller';
import { GhlSsoService } from './ghl/ghl-sso.service';
import { GhlTokenService } from './ghl/ghl-token.service';
import { GhlReputationService } from './ghl/ghl-reputation.service';
import { CredentialVaultService } from './credential-vault.service';
import { DataForSeoAdapter } from './dataforseo/dataforseo.adapter';
import { DataForSeoController } from './dataforseo/dataforseo.controller';
import { DataForSeoService } from './dataforseo/dataforseo.service';
import { GithubAdapter } from './github/github.adapter';
import { GithubController } from './github/github.controller';
import { GithubService } from './github/github.service';
import { GoogleAdapter } from './google/google.adapter';
import { GoogleController } from './google/google.controller';
import { GoogleService } from './google/google.service';
import { GoogleTokenService } from './google/google-token.service';
import { GoogleSyncService } from './google/google-sync.service';
import { IntegrationController } from './integration.controller';
import { IntegrationService } from './integration.service';

@Module({
  controllers: [
    IntegrationController,
    GoogleController,
    DataForSeoController,
    GhlWebhookController,
    GhlOauthController,
    GhlSsoController,
    GithubController,
  ],
  providers: [
    IntegrationService,
    CredentialVaultService,
    GhlAdapter,
    GhlWebhookService,
    GhlOauthService,
    GhlSsoService,
    GhlTokenService,
    GhlReputationService,
    GoogleAdapter,
    GoogleService,
    GoogleTokenService,
    GoogleSyncService,
    DataForSeoAdapter,
    DataForSeoService,
    GithubAdapter,
    GithubService,
  ],
  exports: [
    IntegrationService,
    CredentialVaultService,
    GhlAdapter,
    GhlOauthService,
    GhlTokenService,
    GhlReputationService,
    GoogleAdapter,
    GoogleService,
    GoogleTokenService,
    GoogleSyncService,
    DataForSeoAdapter,
    DataForSeoService,
    GithubAdapter,
    GithubService,
  ],
})
export class IntegrationModule {}
