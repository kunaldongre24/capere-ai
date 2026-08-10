# GoHighLevel custom menus

Capere exposes two iframe entry points for the GoHighLevel Marketplace app:

| Menu label | URL |
| --- | --- |
| SEO Command Center | `https://app.capereai.com/embed/seo` |
| AI CMO | `https://app.capereai.com/embed/cmo` |

## Marketplace configuration

In the GoHighLevel Marketplace developer portal, open the Capere app and add
two Custom Menu Links. Configure each link for sub-account/location users,
select the option to open the page inside GoHighLevel, and use the labels and
URLs above. Publish the updated app version after both links are saved.

The routes explicitly allow framing from GoHighLevel and LeadConnector. They
do not accept an organization or location from an unsigned URL parameter.
Tenant selection continues to be enforced by Capere authentication and the
backend organization guards.

## Authentication behavior

If the browser already has a valid Capere session, the menu opens immediately.
Otherwise it shows the Capere sign-in screen once and returns the user to the
requested embedded menu after successful authentication.

`GHL_SSO_KEY` is reserved for a future verified Marketplace SSO exchange. Do
not treat a plain `locationId` query parameter as authentication and do not
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
