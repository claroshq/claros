# Products

> Status: multi-product instances are unreleased (planned for v0.8). Released versions up to v0.7 run one product per install.

One Claros install can serve several products. Each product has its own contacts, events, flows, templates, knowledge base, settings, transport, API keys and team. Data never crosses between products: the same email address in two products is two separate contacts.

Existing installs have one product (slug `default`, or whatever it was renamed to) and keep working as before. Nothing changes until a second product is created.

## Roles

- **Instance admin**: manages the install. Sees every product, acts on each one as an owner, creates and archives products and edits instance settings. The person who claims a fresh install is its instance admin. On an upgraded install, the active owners of the oldest product become instance admins.
- **Owner** and **member**: roles inside one product, as before. A person can be an owner in one product and a member in another.

Every user has a home product: the one they were created in. Signing in lands them there.

## Joining a product

Invite someone from Settings, Team while the product is selected. If the address already belongs to a user of another product, accepting the invite adds the product to that user; they keep one login. Removing someone from a product that is not their home product ends their access to that product only.

## Switching products

The dashboard shows a product switcher at the top of the sidebar when you can act on more than one product. The choice is remembered in the browser. A link can select a product with `?product=<slug>`.

API clients using a dashboard session pick the product with the `X-Claros-Product: <slug>` header (or the `?product=<slug>` query parameter). Without either, a request acts on the product the session was opened on. A product you are not a member of answers 401, the same as an unknown slug.

Ingestion is unchanged: an ingestion key belongs to one product, and events sent with it land in that product.

## Managing products

Instance admins manage products in Settings, Products, or through the API:

| Method and path | Purpose |
|---|---|
| `GET /v1/products` | Products you can act on, with your role in each |
| `POST /v1/products` | Create a product: `{ "name": "...", "slug": "...", "locale": "en" }`. You become its owner |
| `PATCH /v1/products/:slug` | Change `name`, `locale` or `public_host` |
| `POST /v1/products/:slug/archive` | Archive a product |
| `POST /v1/products/:slug/unarchive` | Unarchive it |
| `GET /v1/instance` | Instance settings and every user with their products |
| `PUT /v1/instance/settings/:key` | Set an instance setting: `{ "value": <JSON> }` |

Slugs are 2 to 63 lowercase letters, digits or hyphens, and cannot be changed after creation.

## Archiving

An archived product keeps its data readable in the dashboard and the API. Changes through the dashboard API answer `409 {"error": "Product is archived."}` until it is unarchived. Archiving does not stop ingestion or sending; pause the product's flows first if you want it fully quiet.
