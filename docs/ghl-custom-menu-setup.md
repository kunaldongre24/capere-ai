# GoHighLevel custom pages and SSO

Capere exposes two iframe entry points for the GoHighLevel app:

| Menu label | URL |
| --- | --- |
| Search Visibility | `https://app.capereai.com/embed/seo` |
| Marketing Advisor | `https://app.capereai.com/embed/cmo` |

## Private app configuration

Use a private Marketplace app configuration (the app does not need to be
publicly listed). In Advanced Settings → Auth, generate the app's Shared
Secret and set the same value as `GHL_SSO_KEY` in the Capere backend.

Add two Custom Pages for the sub-account left navigation. Configure each page
as an iframe and use the labels and URLs above. Publish the app version and
install/update it in the target locations.

The routes explicitly allow framing from GoHighLevel and LeadConnector. They
do not accept an organization or location from an unsigned URL parameter.
Tenant selection continues to be enforced by Capere authentication and the
backend organization guards.

## Authentication behavior

The embedded page requests the authenticated GHL user context from its parent,
posts the encrypted context to Capere, and receives a one-time Capere session.
No Capere password form is used. Capere verifies the active GHL location before
creating or reusing the user's organization membership.

Do not treat a plain `locationId` query parameter as authentication and do not
bypass Capere membership checks for an iframe request.

## Verification

After publishing the Marketplace changes:

1. Open a GoHighLevel sub-account with the Capere app installed.
2. Select **SEO Command Center** and confirm the Overview and all tabs load.
3. Select **AI CMO** and confirm the Morning Brief and Ask CMO tabs load.
4. Repeat from a different sub-account and confirm it cannot see the first
   organization's data.
5. Confirm browser developer tools show no `frame-ancestors` or
   `X-Frame-Options` refusal.
