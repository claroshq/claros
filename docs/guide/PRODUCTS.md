# Products

> Since v0.8. Versions up to v0.7 run one product per install.

One Claros install can serve several products. Each product has its own contacts, events, flows, templates, topics, knowledge base, settings and brand, transports and routing, API keys and team. Data never crosses between products: the same email address in two products is two separate contacts.

Existing installs have one product (slug `default`, or whatever it was renamed to) and keep working as before. Nothing changes until a second product is created.

## Roles

- **Instance admin**: manages the install. Sees every product, acts on each one as an owner, creates and archives products and edits instance settings. The person who claims a fresh install is its instance admin. On an upgraded install, the active owners of the oldest product become instance admins.
- **Owner** and **member**: roles inside one product, as before. A person can be an owner in one product and a member in another.

Every user has a home product: the one they were created in. API requests from a dashboard session without a product header act on it.

## Joining a product

Invite someone from Settings, Team while the product is selected. If the address already belongs to a user of another product, accepting the invite adds the product to that user; they keep one login. Removing someone from a product that is not their home product ends their access to that product only.

## Opening and switching products in the dashboard

What the dashboard opens on depends on how many **active** (not archived) products you can act on:

| Active products | On sign-in or a new browser tab |
|---|---|
| One | It opens directly, even when your home product or the product you last used is archived. |
| Two or more | A full-screen product picker opens first. |
| None | Instance admins get the picker, with "New product" and the archived products. Everyone else opens their current product, read-only. |

The picker shows one card per active product: its brand logo (Settings, Branding; the two-letter monogram when there is none or it does not load), name, slug, public host and your role. The sidebar switcher uses the same logos. The product you chose last is highlighted and focused. Arrow keys move between cards, Enter opens one, and `1` to `9` open the matching product directly. Archived products sit in a collapsed "Archived" group and open read-only. Instance admins can create a product from the picker; it opens once created.

The picker shows once per browser tab: reloading or navigating inside the app keeps the product you chose. Signing out and back in, or opening a new tab, shows it again.

Inside the app, the switcher at the top of the sidebar lists your active products, with a check on the open one, a filter field when there are more than six, and two actions: "All products" (the picker) and, for instance admins, "New product". Archived products are not in the switcher; when the open product is archived, the switcher marks it with an "archived" tag. A link can select a product with `?product=<slug>`; the picker is skipped for it.

## Selecting a product in the API

Dashboard sessions and [instance keys](API_KEYS.md#instance-keys) pick the product a request acts on with the `X-Claros-Product: <slug>` header, or the `?product=<slug>` query parameter (the header wins):

```bash
# List the transports of the product "acme" with an instance key (scope transports:write)
curl https://claros.example.com/v1/settings/transports \
  -H "Authorization: Bearer clr_ik_..." \
  -H "X-Claros-Product: acme"
```

- **Dashboard sessions**: without either, a request acts on the product the session was opened on (your home product). A product you are not a member of answers `401`, the same as an unknown slug.
- **Instance keys** (`clr_ik_`) belong to no product. Product routes their scopes allow need the header: `400` without it, `404` for an unknown slug. See [Instance keys](API_KEYS.md#instance-keys) for scopes.
- **Ingestion and admin keys** belong to one product and ignore the header: events sent with an ingestion key land in its product.

## Managing products

Instance admins manage products in Settings, Products, or through the API:

| Method and path | Purpose |
|---|---|
| `GET /v1/products` | Products you can act on: `{ "products": [{ "id", "slug", "name", "role", "archived", "public_host", "logo_url" }], "instance_admin": true }`. `logo_url` is the product's `brand.logo_url` or `null` |
| `POST /v1/products` | Create a product: `{ "name": "...", "slug": "...", "locale": "en" }`. You become its owner |
| `PATCH /v1/products/:slug` | Change `name`, `locale` or `public_host` |
| `POST /v1/products/:slug/archive` | Archive a product |
| `POST /v1/products/:slug/unarchive` | Unarchive it |
| `GET /v1/instance` | Instance settings and every user with their products |
| `PUT /v1/instance/settings/:key` | Set an instance setting: `{ "value": <JSON> }` |
| `GET/POST /v1/instance/keys`, `POST /v1/instance/keys/:id/revoke` | [Instance keys](API_KEYS.md#instance-keys) for scripts and CI |
| `DELETE /v1/instance/people/:email` | Erase a person in every product |

Scripts can do the same with an [instance key](API_KEYS.md#instance-keys) (`products:write`, `instance:read`) instead of a session.

Slugs are 2 to 63 lowercase letters, digits or hyphens, and cannot be changed after creation.

## Archiving

Archive a product in Settings, Products, or with `POST /v1/products/:slug/archive`. An archived product keeps its data readable in the dashboard and the API: it opens read-only from the picker's "Archived" group or from Settings, Products. Changes through the dashboard API answer `409 {"error": "Product is archived."}` until it is unarchived. An archived product is quiet: `POST /v1/track`, `/v1/identify` and `/v1/batch` answer `403 {"error": "Product is archived."}`, the scan (lifecycle transitions, enrollments, new messages) skips it and the drain sends none of its approved messages. Unarchiving resumes all of it; approved messages that waited are sent by the next drain.
