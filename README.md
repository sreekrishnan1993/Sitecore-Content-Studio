# 🏪 Sitecore Marketplace Starter

This project is the starter template for building Sitecore Marketplace extensions. It demonstrates five extension points: **Custom Field**, **Dashboard Widget**, **Fullscreen**, **Pages Context Panel**, and **Standalone**. Each extension point has its own UI and integration with the Sitecore Marketplace SDK.

## 🧩 Extension Points

### 1. Custom Field Extension

- **Location:** `app/custom-field-extension/page.tsx`
- **Description:**  
  Provides a button-based UI for selecting preset options to showcase how to update field values.
  - Initializes the Marketplace SDK client.
  - On button click,, updates the field value using client.setValue(selected) and closes the app after a short delay.

---

### 2. Dashboard Widget Extension

- **Location:** `app/dashboard-widget-extension/page.tsx`
- **Description:**  
  Displays a widget in the XM Cloud dashboard.
  - Initializes the Marketplace SDK client.
  - Displays sample dashboard information.

---

### 3. Fullscreen Extension

- **Location:** `app/fullscreen-extension/page.tsx`
- **Description:**  
  Provides a fullscreen experience to be rendered in the Pages application.
  - Initializes the Marketplace SDK client.
  - Displays sample dashboard information.

---

### 4. Pages Context Panel Extension

- **Location:** `app/pages-contextpanel-extension/page.tsx`
- **Description:**  
  Displays context information about the current page in the XM Cloud Pages editor.
  - Initializes the Marketplace SDK client.
  - Subscribes to `pages.context` using the SDK to handle events.
  - Shows page ID, title, language, and path.
  - Updates data automatically as the user changes selected page.

---

### 5. Standalone Extension

- **Location:** `app/standalone-extension/page.tsx`
- **Description:**  
  Runs as a standalone app outside of other extension points.
  - Initializes the Marketplace SDK client.
  - Displays sample dashboard information.

# 📦 Getting Started

Note: You cannot access extension point routes directly in the browser (e.g., localhost:3000/...). These routes must be invoked within the Sitecore XM Cloud environment through the configured extension points.To learn how to properly configure and hook up your app to extension points, refer to the official [Sitecore Marketplace documentation](https://doc.sitecore.com/mp/en/developers/marketplace/extension-points.html)


1. Create Your Own Repository:
   - You can either fork this repository or create a new template based on it.
   - This gives you a clean starting point with all the necessary scaffolding for Marketplace extension development.

2. Remove the endpoints you dont require
   - Remove any extension points you don't plan to support by deleting their respective folders inside the app directory.
   - Each folder in app corresponds to a specific extension point (e.g., custom-field-extension, dashboard-widget-extension, etc.).

3. Install dependencies:
   ```sh
   npm install
   ```

4. Run the development server:
   ```sh
   npm run dev
   ```

5. Install the application and test in the different extension points by following the [Sitecore documentation](https://doc.sitecore.com/mp/en/developers/marketplace/introduction-to-sitecore-marketplace.html)

# ✍️ Content Studio (MVP)

Content Studio turns PDFs, Word documents and public publication URLs into structured content. Authors review the extracted content on a whiteboard, map it to a Sitecore template and create an unpublished item.

- **Route:** `/content-studio` (register it as a **Fullscreen** extension point). The starter's other extension routes are unchanged.
- **Workflow:** Upload → Extraction results → Whiteboard → Images & media → Template mapping → Preview & create.
- **Other screens:** Home, Recent Documents, Templates, Media Library, Settings.

## Run and validate

```sh
npm install
npm run dev            # http://localhost:3000/content-studio (demo mode when opened outside Sitecore)
npm run lint
npm run typecheck
npm test               # unit tests: extraction, mapping, whiteboard, live adapter (mocked SDK), security
npm run build && npm start
npm run fixtures       # writes sample PDF/DOCX/scanned files to tests/fixtures/generated/ for manual testing
npm run preflight      # deployment configuration check (sandbox or production)
npm run start:sandbox  # production server bound to 127.0.0.1:3000 only
```

`npm run dev` with no `CONTENT_STUDIO_AUTH_MODE` runs the extraction API **unauthenticated** (development default), and `next dev` listens on all interfaces. Use it only on a trusted machine and network, or run `npx next dev -H 127.0.0.1`.

## How extraction works

`POST /api/extract` (Node.js runtime) receives a file (`multipart/form-data`, field `file`) or `{ "url": "..." }`.

1. The request passes the security checks described below.
2. The file type comes from the file signature, not the name or MIME type. Files are processed in memory and never written to disk.
3. A **source adapter** reads the document and reports its structure in a format-agnostic form (`src/lib/extraction/structure/model.ts`). It says what the source states and leaves out what it doesn't know:
   - element kind (heading, paragraph, list item, quote, caption, table row);
   - explicit heading level and title style;
   - list membership, nesting level, numbering and marker;
   - bold and italic coverage (all, partial or none);
   - font size;
   - container (page, slide, table, figure, column or section);
   - location, and the verbatim source text when the adapter had to normalize it.

   The adapters:
   - **PDF:** `unpdf` (pdf.js). Lines are assembled into paragraphs and list items (bullets and numbers start an item; wrapped lines stay in it), with font size and indentation.
     - PDF text carries no reliable bold information, so bold is reported as unknown.
     - It also extracts metadata, link annotations and embedded images (encoded to PNG).
     - XFA is off and decoded images are capped at 25 megapixels.
   - **DOCX:** `mammoth` produces semantic HTML: Heading 1–6, Title, Subtitle and Caption styles, and nested or numbered lists. Bold runs become `<strong>`.
     - Core properties are read with `jszip`.
     - Before parsing, every ZIP entry is decompressed with a hard 100 MB cap, so a file whose headers lie about its size is rejected.
     - External files are never loaded.
   - **URL:** fetched server-side with the SSRF protections described below. Static HTML is parsed with `node-html-parser`; scripts are removed and never run.

   Word and web pages share one HTML structure reader (`structure/html.ts`).
4. **Shared classification** (`structure/classify.ts`) assigns each element a role (title, heading, description, body, list item, quote, caption, call to action, table row, or noise) from combined evidence:
   - explicit semantics;
   - typography relative to the document's body size;
   - position;
   - the neighbouring elements.

   Rules that keep it from over-reading single signals:
   - bold alone never makes a title or heading;
   - a short paragraph without emphasis is body text;
   - an inline bold label stays body;
   - plain text gives at most an *uncertain* title.

   Every block carries a confidence and its evidence; uncertain ones show **Check type** on the whiteboard.
5. **Shared grouping** (`structure/group.ts`) builds logical blocks:
   - one block per list, keeping items and nesting;
   - consecutive paragraphs of a section joined, up to 4 paragraphs or 1,500 characters;
   - titles, headings, quotes (with attribution), captions and calls to action kept separate;
   - each table kept as its own block.

   Boundaries:
   - a new heading starts a new section;
   - a page break is only context (a paragraph broken across pages is rejoined);
   - slides, columns, figures and tables are hard boundaries.

   Grouping never rewrites text, and tests prove nothing is lost or duplicated.
6. `src/lib/extraction/classify.ts` turns groups into blocks and adds statistics, links and SEO metadata.
   - Blocks are labelled **Extracted** (verbatim) or **Derived** (for example, a truncated meta description).
   - Each block keeps its page and location, and the original source text when it differs.
7. On the whiteboard:
   - list items are edited individually (with indent and outdent);
   - **Split…** and **Merge ↓** regroup body and list cards;
   - changing a card's type converts between list items and paragraphs without losing text.
8. Scanned PDFs with no text layer return a clear `scanned-document` error. OCR is not configured.

**Adding a source format.** Write an adapter that produces a `StructuredDocument` (`elements` in reading order, plus `links`) and call `buildContentBlocks(doc, metadata)`. Report only what the format states:
- **HTML-producing parsers** can reuse `htmlToStructure`.
- **Layout formats** report `fontSize`, and list markers as `list`.
- **Slide decks** set `container: { type: "slide", id }` on each element.

Add a fixture expressing the same structure to `tests/structure.test.ts` ("equivalent … documents produce the same content blocks"). Real documents can be dropped into `tests/fixtures/samples/` for format-independent checks.

`src/lib/extraction/ai.ts` defines an optional `ContentEnhancer` hook. It may add blocks marked `ai-suggestion` but never changes extracted blocks. None is configured.

## Security model for `/api/extract`

**Identity.** With Marketplace *built-in* authorization, the client SDK gives the browser nothing this server can verify. `host.user` is unsigned and is never trusted, and no header proves identity on its own. Sitecore documents *custom authorization (Auth0)* as the way for an app's server to obtain a Sitecore user token. The endpoint therefore supports two modes (`src/lib/security/auth.ts`):

| Mode | Behaviour |
|---|---|
| `auth0` | Requires `Authorization: Bearer <JWT>`. Checks the signature against the tenant's JWKS (RS256 only) plus issuer, audience, expiry and `sub`. Optionally checks the client (`azp`/`client_id`) and organization claim. |
| `none` | No authentication. Default in development. In production it also requires `CONTENT_STUDIO_ALLOW_UNAUTHENTICATED=true`. Use it only for a controlled sandbox. |
| *(unset in production)* | **Fails closed:** every POST returns 503 and the UI disables uploads. |

**Browser sign-in** (`src/components/state/ApiAuth.tsx`). Create *Single Page App* client credentials for the app in the Cloud Portal (no client secret is used). When Content Studio runs inside Sitecore and `NEXT_PUBLIC_CONTENT_STUDIO_AUTH0_CLIENT_ID` is set, `@auth0/auth0-react` signs the user in with Sitecore in a pop-up (Sitecore's sign-in page cannot be shown inside the iframe). The organization, tenant and app (`organization_id`, `tenant_id`, `product_codes=mkp_<app ID>`) come from the Marketplace application context, so one deployment serves every tenant. Refresh tokens are kept in local storage because silent renewal through a hidden iframe fails when third-party cookies are blocked. `getAccessTokenSilently` is registered with `setApiTokenProvider()` (`src/lib/security/client-auth.ts`), and each upload sends the token as a bearer token. The token only proves who is calling Content Studio's API; Sitecore content is still read and written through the Marketplace SDK.

Example for a public deployment (Vercel project settings; `NEXT_PUBLIC_*` values are built into the browser code, so redeploy after changing them):

```
CONTENT_STUDIO_DEPLOYMENT=production
CONTENT_STUDIO_AUTH_MODE=auth0
CONTENT_STUDIO_AUTH0_DOMAIN=auth.sitecorecloud.io
CONTENT_STUDIO_AUTH0_AUDIENCE=https://api-webapp.sitecorecloud.io
CONTENT_STUDIO_AUTH0_CLIENT_IDS=<client ID>
NEXT_PUBLIC_CONTENT_STUDIO_AUTH0_CLIENT_ID=<client ID>
```

The domain and audience are the values Sitecore's custom-authorization samples use; confirm them for your organization.

**Other controls, in request order:**
1. Cross-site browser requests are refused (`Sec-Fetch-Site` / `Origin`). This is not authentication.
2. Rate limit per verified user, or per IP from an operator-declared trusted header. Otherwise there is one shared anonymous bucket; forwarding headers are never trusted by default.
3. A cap on concurrent extractions.
4. Streaming body limits: chunked uploads without `Content-Length` can't bypass them. JSON bodies are capped at 4 KB.
5. Exactly one file per upload, a signature check, and the extension must match the content.
6. A 45-second processing deadline.
7. `Cache-Control: no-store` responses.
8. Generic error messages: parser internals and document text are never returned or logged.

The in-process limits protect one server instance only. **Platform-level rate limiting is still required** (WAF, API gateway or hosting provider).

**URL import (SSRF).**
- Only http/https on ports 80/443, with no embedded credentials. Single-label, `.local` and `.internal` hosts are rejected.
- Addresses are parsed to bytes and must be public unicast. IPv4 embedded in IPv6 (mapped, compatible, NAT64, 6to4) is extracted and checked. Private, loopback, link-local (including cloud metadata), CGNAT, multicast and documentation ranges are blocked.
- **DNS rebinding:** the check runs inside the socket's DNS lookup, so the address validated is the address connected to.
- Every redirect (max 3) is re-checked.
- There is one overall 10 s deadline, a 5 MB streaming cap, and uncompressed transfer only; proxy environment variables are ignored.

**Headers.** `/content-studio` and `/api/extract` send:
- `Content-Security-Policy: frame-ancestors …` (default `'self' https://*.sitecorecloud.io`; override with `CONTENT_STUDIO_FRAME_ANCESTORS` **at build time**);
- `object-src 'none'`, `nosniff`, a referrer policy and a permissions policy.

Starter routes are unchanged.

## Demo mode vs live mode

| | Demo mode | Live mode |
|---|---|---|
| When | Opened outside Sitecore, the host doesn't respond, the app has no resource access, or "Use demo data" is set in Settings | Opened from SitecoreAI / XM Cloud with resource access |
| Extraction, whiteboard, media metadata, mapping, preview | Fully functional | Fully functional |
| Sites, languages | Mock data labelled "(demo)" | `xmc.sites.listSites`, `xmc.sites.listLanguages` |
| Templates | Mock data | Authoring GraphQL: templates under the template root; fields include inherited base templates; "required" comes from the field's *Required* validation rule, shown as unknown when the rules can't be read |
| Destination check | Path format only | Authoring GraphQL `item(where: { path })` |
| Create item | Never sends anything. Shows the request | Duplicate-name check, then `createItem` with braced GUIDs. Never publishes |
| Media upload | Not available | Off by default. Experimental opt-in in Settings through the Agent API |

The live adapter uses the Context ID from `application.context` → `resourceAccess[0].context.live`, as in Sitecore's Marketplace SDK examples, falling back to `preview`. The host attaches the user's token, so permissions are those of the signed-in Sitecore user.

**Creation outcomes.** The UI distinguishes three cases:
- **created:** Sitecore returned the item, or a lookup by path confirms it exists;
- **failed:** Sitecore answered and the item doesn't exist;
- **uncertain:** a timeout or lost connection.

An attempt is recorded as *pending* before the request is sent. If the page reloads mid-request, or the result is uncertain, creation stays blocked until **Check in Sitecore** resolves it by looking the item up. A synchronous lock prevents double submission.

**Media upload findings.**
- **GraphQL `uploadMedia`:** returns a presigned URL that must be called with the user's bearer token. The client SDK doesn't expose that token, so this path is **not usable** with built-in authorization.
- **Agent API `xmc.agent.assetsUploadAsset`:** typed in the installed SDK (`POST /api/v1/assets/upload`, multipart `file` + `upload_request`) and proxied by the host with the user's credentials. It's implemented but **unverified** on a tenant. The SDK serializes the multipart body inside the app, so the file bytes travel as part of the request body. An image is marked uploaded only when Sitecore returns `success: true` and a media item ID that can be found by ID. Image fields then get `<image mediaid="{…}" />` (see *Media upload and Image fields*).
- **Alternatives:** custom authorization with server-side upload using the experimental `experimental_createXMCClient` tooling, a DAM connector, or manual upload (originals can be downloaded from the Images step).

## Environment variables (server only)

| Variable | Default | Purpose |
|---|---|---|
| `CONTENT_STUDIO_AUTH_MODE` | *(unset)* | `auth0` or `none`. Unset in production = fail closed |
| `CONTENT_STUDIO_ALLOW_UNAUTHENTICATED` | — | Must be `true` to use `none` in production (sandbox only) |
| `CONTENT_STUDIO_AUTH0_DOMAIN` | — | Auth0 tenant domain, e.g. `example.auth0.com` (required for `auth0`) |
| `CONTENT_STUDIO_AUTH0_AUDIENCE` | — | Expected `aud` of access tokens (required for `auth0`) |
| `CONTENT_STUDIO_AUTH0_CLIENT_IDS` | — | Comma-separated allowed `azp`/`client_id` values |
| `CONTENT_STUDIO_ALLOWED_ORG_IDS` | — | Comma-separated allowed organization IDs |
| `NEXT_PUBLIC_CONTENT_STUDIO_AUTH0_CLIENT_ID` | — | The app's Single Page App client ID, for browser sign-in. Not a secret; built into the browser code |
| `NEXT_PUBLIC_CONTENT_STUDIO_AUTH0_DOMAIN` | `auth.sitecorecloud.io` | Sign-in domain used by the browser |
| `NEXT_PUBLIC_CONTENT_STUDIO_AUTH0_AUDIENCE` | `https://api-webapp.sitecorecloud.io` | Audience the browser requests; must equal `CONTENT_STUDIO_AUTH0_AUDIENCE` |
| `CONTENT_STUDIO_AUTH0_ORG_CLAIM` | `org_id` | Claim name holding the organization ID |
| `CONTENT_STUDIO_RATE_LIMIT_PER_MINUTE` | `10` | Extractions per user (or IP / shared bucket) per minute, per instance |
| `CONTENT_STUDIO_MAX_CONCURRENT_EXTRACTIONS` | `2` | Concurrent extractions per instance |
| `CONTENT_STUDIO_TRUSTED_IP_HEADER` | — | Header set by *your* proxy that holds the client IP (e.g. `x-real-ip`) |
| `CONTENT_STUDIO_MAX_UPLOAD_MB` | `15` | Upload limit (max 50) |
| `CONTENT_STUDIO_ENABLE_URL_IMPORT` | `true` | `false` disables server-side URL fetching |
| `CONTENT_STUDIO_FRAME_ANCESTORS` | `'self' https://*.sitecorecloud.io` | Allowed embedding hosts. **Read at build time** |
| `CONTENT_STUDIO_DEPLOYMENT` | *(unset = unmarked)* | `sandbox` or `production`. `sandbox` enables the sandbox write guard below. Does not change authentication |
| `CONTENT_STUDIO_SANDBOX_TENANT` | — | With `sandbox`: the only tenant (name, display name, tenant ID or resource ID) that live creation and media upload may target. Not secret: `GET /api/extract` reports it |

No secrets are needed for `none` mode, and the Auth0 settings above are not secrets. Never put secrets in `NEXT_PUBLIC_*` variables.

## Marketplace configuration

Sitecore's docs ([configure and activate a custom app](https://doc.sitecore.com/mp/en/developers/marketplace/configure-and-activate-a-custom-app.html)) allow the deployment URL to be a localhost address during development, e.g. `http://localhost:3000` for Next.js. The app must be started on exactly that address.

| Setting | Sandbox test value |
|---|---|
| App type | **Custom** app |
| Deployment URL | `http://localhost:3000` (private local test, see below) |
| Authorization | Built-in |
| Extension point | **Fullscreen**, route `/content-studio` ([extension points](https://doc.sitecore.com/mp/en/developers/marketplace/extension-points.html)). No other extension points are needed |
| Resource access | **Exactly one** environment: the sandbox SitecoreAI / XM Cloud environment. The app uses `resourceAccess[0]`, and the sandbox guard refuses writes when more than one is granted |
| API access | **Sites API** and **Authoring and Management GraphQL API**. Add the **Agent API** only for the optional media test, and remove it afterwards |
| Permissions | Optional: clipboard write. Pop-ups and downloads are not needed |
| Test user | Read access to the template root and site; create and delete rights on the test destination folder only (plus a test Media Library folder for the media test) |

**Before broader use:**
- switch to custom authorization: create client credentials ([docs](https://doc.sitecore.com/mp/en/developers/marketplace/create-client-credentials.html)), wire Auth0 sign-in in the browser, and set `CONTENT_STUDIO_AUTH_MODE=auth0`;
- deploy over HTTPS behind platform-level rate limiting;
- set `CONTENT_STUDIO_FRAME_ANCESTORS` before building if the host is not under `*.sitecorecloud.io`.

## Controlled sandbox validation

### Safe sandbox setup

**Why a private local server works.** With built-in authorization, every Sitecore call goes from the browser to the Sitecore host via the Marketplace SDK (postMessage); the host adds the user's token. Sitecore never calls this app's server. So the app only has to be reachable from the tester's own browser, and the server can listen on `127.0.0.1` only. That is the only setup where `CONTENT_STUDIO_AUTH_MODE=none` is acceptable.

**Never run `none` on a publicly reachable server.** If the test must run on a shared or hosted URL (another tester's machine, a review deployment), do one of these:
- keep `auth0` mode (requires the client sign-in work);
- put an authenticating reverse proxy in front: SSO / identity-aware proxy, or an IP allow-list for the testers *plus* basic auth. The page and `/api/extract` must both be behind it, and the Sitecore iframe must be able to load the page through it;
- otherwise, do not test there.

**Setup steps:**

1. Copy the template: `cp .env.sandbox.example .env.production.local` (git-ignored).
2. Set `CONTENT_STUDIO_SANDBOX_TENANT` to the sandbox tenant's name or ID. The app shows it under *Settings → Sitecore integration → Tenant*.
3. Build and start bound to loopback:
   ```sh
   npm run build
   npm run start:sandbox      # next start -H 127.0.0.1 -p 3000
   ```
4. Run the preflight against the running server:
   ```sh
   npm run preflight -- --url http://localhost:3000
   ```
5. Use only synthetic documents: `npm run fixtures` writes them to `tests/fixtures/generated/`. Never use confidential documents, because the endpoint has no identity check in this mode.
6. Afterwards, stop the server, delete `.env.production.local`, and set the app's deployment URL back to its real value (or deactivate the app).

**What the configuration does:**

| Variable | Effect |
|---|---|
| `CONTENT_STUDIO_DEPLOYMENT=sandbox` | Marks the deployment as a sandbox. Live item creation and media upload are disabled unless the app has access to **exactly one** environment and it matches `CONTENT_STUDIO_SANDBOX_TENANT`. This guard is client-side: it protects against testing on the wrong tenant, and is not a security boundary |
| `CONTENT_STUDIO_AUTH_MODE=none` + `CONTENT_STUDIO_ALLOW_UNAUTHENTICATED=true` | Unauthenticated extraction. Both are required in production. Without them, production refuses all extraction (503) |
| `CONTENT_STUDIO_ENABLE_URL_IMPORT=false` | URL import isn't needed for the test, so the server-side fetcher stays off |

Nothing in this repository enables unauthenticated mode by default in production. The sandbox variables don't change any authentication default.

### Preflight

**`npm run preflight [-- --url <base>]`** (`scripts/preflight.mjs`). It reads `.env*` files with Next.js precedence plus process variables, and exits 1 on any failure.
- **Configuration checks:**
  - the deployment is marked: `production` (works in whichever tenant opens the app) or `sandbox` (then the sandbox tenant must be set). Unmarked fails;
  - the resolved auth mode, which mirrors `src/lib/security/auth.ts` and is tested against it. `none` on an unmarked deployment fails; an unconfigured production server fails;
  - URL import, numeric limits, and no secret-looking `NEXT_PUBLIC_*` variables;
  - the `frame-ancestors` actually compiled into `.next/routes-manifest.json`.
- **With `--url`:**
  - `GET /api/extract` (running auth mode and deployment must match this configuration);
  - `GET /content-studio` CSP header;
  - one **empty** `POST /api/extract` with no body, which shows whether unauthenticated calls are accepted;
  - unauthenticated mode at a non-loopback hostname is a failure.
- **What it never does:** contact Sitecore, send a document, create content or upload media.

**Settings → Preflight** (inside Sitecore). Read-only:
- connection (live or demo);
- server auth mode and deployment (`production` or `sandbox`);
- target environment: the tenant detected from the host (name and ID, number of environments granted). For `sandbox` it must match `CONTENT_STUDIO_SANDBOX_TENANT`; for `production` any tenant passes;
- `/content-studio` extension-point registration (from `application.context`);
- the media upload setting;
- **Sites API** (`xmc.sites.listSites`, `xmc.sites.listLanguages`);
- **Authoring GraphQL** (`item` query on the template root).

It uses only `query` operations; a unit test asserts it sends no GraphQL mutation and no Agent API call. All checks except *Media upload* must pass before step 7 below. *Extension point* may show *Check* if the host doesn't report extension points.

### GraphQL operations used (all through `xmc.authoring.graphql`)

| Operation | Purpose | Documented in [authoring query examples](https://doc.sitecore.com/xmc/en/developers/xm-cloud/query-examples-for-authoring-operations.html) |
|---|---|---|
| `item(where: { database: "master", path })` `{ itemId name path }` | Destination, duplicate check, uncertain-outcome lookup, preflight | Yes (by path and by `itemId`) |
| `item(where: { database: "master", itemId })` with `children { nodes { … } }`, `template { name }`, `field(name: "Type") { value }`, `field(name: "__Base template") { value }` | Template sections, fields, field types, inheritance | Each construct is used in the examples. Reading *template definition items* this way must be confirmed on the tenant (step 3) |
| Same, with `field(name: "__… Validation Rules")` on field definitions | Required fields (Required validator `{59D4EE10-627C-4FD3-A964-61A88B092CBC}`) | The field names and validator ID are standard Sitecore, not shown in the examples. Must be confirmed on the tenant (step 5) |
| `createItem(input: { name, templateId, parent, language, fields })` `{ item { itemId name path } }` | Create one unpublished item | Yes, same inputs |

No `publish`, `deleteItem`, `updateItem` or `uploadMedia` mutation exists in the app.

### Automated (mock) tests vs real-tenant checks

| Covered by `npm test` (mocked SDK, no tenant) | Requires the real sandbox tenant |
|---|---|
| Exact SDK keys, Context ID and request shapes | That the host accepts them and returns the shapes the adapter expects |
| Site and language mapping; 403 → permission message | The real site and language lists for the test user |
| Template field parsing, inheritance and Standard template exclusion | That `children` / `field(name:)` work on template definition items |
| Required detection from validation-rule values | The real validation-rule field names and Required validator ID |
| Duplicate check before mutation; created / failed / uncertain logic | Real create and permission errors, and real timing |
| Media upload request shape; success only with `success: true` + a GUID | Whether the host forwards the `Blob`, and what the Agent API returns |
| Sandbox guard, preflight read-only behaviour, CLI and server auth parity | The tenant name and resource ID the host reports |

### Live test sequence

**Prerequisites:**
- the setup above is done;
- the CLI preflight has no failures;
- there's a dedicated sandbox site;
- there's an empty, throwaway destination folder, e.g. `/sitecore/content/<collection>/<site>/Home/ContentStudioTest`;
- one tester runs the sequence, and the DevTools *Network* tab is open in the Sitecore window to watch `postMessage` traffic and console errors.

Record the result of every step.

| # | Step | Expected result | If it fails |
|---|---|---|---|
| 0 | Open the app from the Fullscreen extension point. **Settings → Preflight → Run** | Badge **Live**. All checks pass except possibly *Extension point*; *Target environment* shows the sandbox tenant | Blank frame: check the console for a `frame-ancestors` error; set `CONTENT_STUDIO_FRAME_ANCESTORS` to the host origin and rebuild. *Target environment* fails: fix the resource access or `CONTENT_STUDIO_SANDBOX_TENANT`. API failures: check the API access settings and the user's role |
| 1 | **Site discovery:** Template mapping → Site list | The sandbox site(s) are listed with display names | Permission message: the user's role. *Unexpected response*: record the raw response from the network log; the Sites API shape differs |
| 2 | **Language discovery:** choose the site | The site's languages are listed (or the tenant languages) | Same as step 1 |
| 3 | **Template and field discovery:** choose a test template | The "Select a content template" error clears and its sections and fields appear with the right types. In the Authoring GraphQL IDE, run `TEMPLATE_FIELDS_QUERY` from `src/lib/sitecore/graphql.ts` with the template ID and compare | Empty list: change the template root in Settings. GraphQL errors on `children` or `field`: record them; the template reader needs adapting |
| 4 | **Inherited fields:** a template with a base template | Inherited fields show *inherited from &lt;base&gt;*; Standard template fields are absent | Missing fields: check `__Base template` on the template item in the IDE |
| 5 | **Required fields:** a template whose field has the *Required* validation rule | **Required (validation rule)** on that field; leaving it unmapped blocks creation. If the rules can't be read, the UI says required information is *unknown* | No badge: in the IDE, read the field's `__Validator Bar Validation Rules` etc. and compare the validator ID |
| 6 | **Destination and duplicate name:** enter the test folder → **Verify**. Then a non-existent path, and a path with placeholder text such as `<site>` | Folder found ("Verified in Sitecore"), and a clear "not found" message for the bad path. Placeholder paths are refused without calling Sitecore. In live mode **Preview** stays disabled until the current path is verified; editing the path or changing the site clears the verification. With an item name that already exists in the folder, creation is refused before any `createItem` (check the network log) | Duplicate not detected: stop; do not continue to step 7 |
| 7 | **One confirmed test item:** follow *Controlled item creation test* below. Preview → **Create content item** | The confirmation lists environment (**Sandbox** badge, tenant), site, template with path, **parent path**, new item path, language, fields written and left empty, and validation counts. Only **Create item** sends anything | Creation disabled with a sandbox message: the guard is working; fix the configuration, not the guard |
| 8 | **Verify in Sitecore:** Content Editor → the new item | Exists at the shown path with the recorded ID, right template and language; field values match; rich text intact; **not published** (not on Edge / the publishing target) | Item missing but the app said created: a critical defect; stop and record the network log |
| 9 | **Uncertain outcome without duplicates:** with a new item name, click **Create item**, immediately set DevTools Network to *Offline* (or reload the page mid-request) | "The result of the last creation attempt is unknown"; **Create** stays disabled. Go back online → **Check in Sitecore** → either "Sitecore confirms the item exists" or "not found, you can try again". Only one item exists afterwards | A second item appears: a critical defect; stop |
| 10 | **Cleanup** (see below) | The test folder is empty again | — |
| 11 | **Media upload (optional):** see *Media upload and Image fields* | — | — |
| 12 | **Extraction endpoint:** from another site's console, `fetch('http://localhost:3000/api/extract', {method:'POST'})` | Blocked (CORS / 403 `forbidden-origin`) | — |

**General recovery.** Any unexpected *success without an item*, or a duplicate item, is a stop-the-test defect. Delete the test items and record:
- the network log;
- the browser console;
- the exact step.

Never retry creation while an *unknown* outcome is shown. Use **Check in Sitecore**.

### Controlled item creation test

Run this once per configuration change. It creates **exactly one** unpublished item.

1. **Confirm the sandbox environment.**
   - Settings → *Sitecore integration* shows the tenant. Settings → *Preflight* must show **Target environment: Pass** and **createItem schema: Pass**.
   - If *Target environment* fails with "CONTENT_STUDIO_SANDBOX_TENANT is not set", the message names the connected tenant. Put that value in `.env` as `CONTENT_STUDIO_SANDBOX_TENANT=<tenant name>`, restart the server, and run the preflight again.
   - *createItem schema* compares the tenant's real `createItem` input type with what the app sends, using read-only introspection. If it shows *Check* (introspection disabled), confirm in the GraphQL IDE that `createItem(input: { name, templateId, parent, language, fields: [{ name, value }] })` is valid.
2. **Select a verified parent and a template.** In Template mapping, choose the template, enter the test folder path, select **Verify**, and wait for "Verified in Sitecore".
3. **Use a unique item name**, e.g. `ContentStudio-Test-20261027-1430` (`ContentStudio-Test-YYYYMMDD-HHMM`).
4. **Review the payload.** Preview → **Create content item** opens the confirmation.
   - Check the environment (Sandbox badge), parent path, new item path, template, language, and the fields written or left empty.
   - Open **Review the exact request**: it is the exact GraphQL mutation that will be sent, with braced GUIDs for `templateId` and `parent`, and fields as `{ name, value }` using field **names**.
5. **Confirm explicitly.** Only **Create item** sends anything. A second click is ignored while the request runs.
6. **Exactly one item is created.** The result shows the item ID and path returned by Sitecore. "Created" is shown only when Sitecore returned the item, or when a lookup found it after an error or timeout (a warning says which).
7. **Verify in Sitecore.** In the Content Editor, find the item at the shown path. Its ID must match, its fields must be filled, and it must not be published.
8. **Error handling, without creating more items:**
   - Create again with the same name: refused before any mutation ("already exists").
   - A parent path that doesn't exist: refused at Verify.
   - Optional, with a test user who can't create under the folder: *Not created: permission denied*.

**Reading a failure.** Each failure has a title and **Technical details**, a sanitized JSON record you can copy into a ticket:
- the operation name and stage;
- whether Sitecore ran the request;
- the HTTP status, and the GraphQL error messages with their paths and codes;
- the input *structure*: field names and value lengths, never values or tokens.

| Title | Meaning | What to do |
|---|---|---|
| *Not created: checks before sending failed* | Destination missing, duplicate name, or invalid template ID. Nothing was sent | Fix the input |
| *Not created: Sitecore rejected the request* | HTTP 400 or a GraphQL schema error: the request doesn't match the tenant's schema. Not executed | Compare the details with *createItem schema* in the preflight |
| *Not created: permission denied* | HTTP 401 or 403, or a Sitecore access error | Check the user's rights on the parent folder, and the app's API access |
| *Not created: Sitecore refused the item* | Sitecore ran the request and returned errors (e.g. invalid field or name). A lookup confirmed no item exists | Fix the field or name named in the error |
| *Not created: Sitecore server error* | HTTP 5xx. A lookup confirmed no item exists | Retry later; report the details if it persists |
| *The result of the last creation attempt is unknown* | No answer (timeout, lost connection) and the item doesn't exist *yet* | Wait a minute, then **Check in Sitecore**. Creation stays blocked until this is resolved; never create it again first |

### Media upload and Image fields (optional, Agent API)

**How an image reaches an Image field.** The order is fixed:
1. Select the image (Images & media).
2. Upload it (Images & media → *Media upload*).
3. Sitecore confirms a media item ID, and the app looks the item up by ID.
4. Choose that image for a specific Image field in Template mapping.
5. Create the item.
6. The app reads the Image field back and compares it with what it sent.

An Image field mapped to an image that isn't confirmed uploaded is a **blocking validation error** in live mode. Content Studio never creates an item with a silently empty image. Automatic mapping fills at most one Image field, and in live mode only with a confirmed upload; other Image fields are chosen explicitly.

**Image field value.** Sitecore stores an Image field as an XML element referencing the media item by its braced ID, `<image mediaid="{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}" />`. That's the raw value Content Studio writes through `createItem`'s `fields: [{ name, value }]`. A bare GUID, a media path or a URL is not a valid Image field value. General Link, Droplink, Droptree and Multilist fields can't receive images.

**Upload operation** (installed SDK `@sitecore-marketplace-sdk/xmc` 0.4.2, `client-agent`). There's no tested end-to-end example, so treat it as **unverified** until the procedure below passes.
- `mutate("xmc.agent.assetsUploadAsset", { params: { query: { sitecoreContextId }, body: { file, upload_request } } })` is `POST /api/v1/assets/upload`, multipart.
- **`file`** is sent as a `File` named `<name>.<ext>` with its MIME type. The SDK's form serializer would send a bare `Blob` as `"blob"`.
- **`upload_request`** is JSON with `name`, `itemPath`, `language`, `extension` and `siteName`. `name` includes the extension, following the SDK's example (`"example.jpg"`).
- **`itemPath` is relative to the Media Library root** (`Project/Site/News`). The tenant prefixes `/sitecore/Media Library/` itself; an absolute path fails with HTTP 404 `Content item with Path /sitecore/Media Library//sitecore/media library/… not found` (observed on the sandbox). You enter the full path in the UI, the app checks that the folder exists (read-only), and converts it before sending.
- **Response:** `{ success, mediaItem: { id, embedUrl, size, dimensions, extension } }`.
- **What counts as uploaded:** `success: true` **and** a GUID `mediaItem.id` **and** the item found by ID afterwards (its path is stored). Anything else is *failed* or *outcome unknown*, and can't be mapped.
- **Before upload:** the type (PNG, JPEG, GIF or WebP) and size are validated.
- **Technical details:** each upload records the HTTP status, `success`, the returned ID, verification and the media path. There's no image data in that record.

**Manual sandbox test** (one image, one item):
1. Grant the Agent API to the app. Create `/sitecore/media library/Project/ContentStudioTest`. Enable *experimental media upload* in Settings.
2. Template mapping: choose a template with an **Image** field. The table shows its Sitecore type (`Image`) and field ID.
3. Images & media: keep one small synthetic PNG selected, set the folder above, select **Upload**, and confirm.
   - **Expected:** *Uploaded* with the media path and `{ID}`.
   - In the Media Library, the item exists at that path with that ID, and the image renders.
4. Template mapping: in the Image field's list, choose the image marked *uploaded: …*. The field status is OK. Any other Image field is unmapped unless you choose it.
5. Preview → **Create content item**:
   - the confirmation's **Images** row shows the field (with ID) and the media item;
   - **Review the exact request** shows `value: "<image mediaid=\"{ID}\" />"`;
   - create one item named `ContentStudio-Test-YYYYMMDD-HHMM`.
6. **Expected:** created with no image warning. *Technical details* show `fieldCheck: [{ "match": true }]`. In the Content Editor, the item's Image field shows the image, and its raw value (View → Raw values) is `<image mediaid="{ID}" />`.
7. **If it fails:**
   - **Upload *Failed*:** copy *Technical details*. The HTTP status and returned values show whether the Agent API rejected the request, returned no ID, or returned an ID that can't be found.
   - **The image field warning after creation** (*was not saved as sent*): Sitecore stored something else. Record the raw value shown.
   - **The raw value is right but the editor shows no image:** check that the media item has a blob attached and that you can read it.
8. **Cleanup:** delete the test item and the test media item, disable the setting, and remove the Agent API access.

### Cleanup

1. In the Content Editor, delete each test item under the test folder; they go to the Recycle Bin. Then delete the test folder if it was created for the test.
2. Delete test media items and the test media folder.
3. Empty the matching Recycle Bin entries if the sandbox must be left clean.
4. Nothing was published, so no unpublish is needed. Confirm on the publishing target that nothing appeared.
5. Turn off experimental media upload, remove the Agent API access, and restore the deployment URL or deactivate the app.
6. Stop the local server, delete `.env.production.local`, and clear the session data (Settings → *Clear session data*).

A GraphQL alternative for step 1 is the documented `deleteItem(input: { path: "<item path>", permanently: false })` in the Authoring GraphQL IDE. The app itself has no delete operation.

## Known limitations

- `none` mode has no identity check. The endpoint is protected only by the origin check, rate limits and size limits. Use it only for a time-boxed sandbox on a loopback-bound server, with synthetic documents.
- In development (`next dev`) with no auth mode set, extraction is unauthenticated by design. Production fails closed.
- The browser sign-in has not yet been tested against a live Sitecore tenant. The `organization_id`, `tenant_id` and `product_codes` sign-in parameters, the domain and the audience follow Sitecore's custom-authorization samples. Server-side token verification is unit-tested with locally generated keys.
- Sign-in opens a pop-up, so the Sitecore iframe must allow pop-ups. Tokens are cached in the browser's local storage for this origin.
- **Deployment requirement:** in-process rate limits are per instance, so platform-level rate limiting (WAF, API gateway or hosting provider) is required for any shared deployment.
- The sandbox write guard and the in-app preflight run in the browser. They prevent testing against the wrong tenant by mistake, not deliberate misuse; Sitecore permissions remain the real control. Grant the test user rights on the test folder only.
- The tenant fields the guard compares (`tenantName`, `tenantDisplayName`, `tenantId`, `resourceId`) come from the SDK's `application.context` types. Their values must be checked on the tenant (step 0).
- The extraction deadline returns to the client, but CPU work already running in-process can't be cancelled; the concurrency cap stays held until it finishes.
- Live template discovery, required-rule reading, item creation and media upload are verified against the SDK types, the official docs and mocked SDK responses, **not against a real tenant**.
- The Required-validator ID `{59D4EE10-627C-4FD3-A964-61A88B092CBC}` and the `__… Validation Rules` field names must be confirmed in the tenant (live test sequence, step 5).
- Insert-option rules are not enforced; Sitecore's API allows creating any template under the parent.
- Classification is rule-based and tuned for press releases. There's no OCR and no AI provider.
- Workspaces are stored in `sessionStorage` (per tab). Very large image sets may not persist across reloads; the UI says so when this happens.

## 📝 License

This project is licensed under the terms specified in the [LICENSE](LICENSE) file.

## 🐛 Issues

If you encounter any issues or have suggestions for improvements, please open an issue on the repository.