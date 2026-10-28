import type { ClientSDK } from "@sitecore-marketplace-sdk/client";
import type {
  CreateDiagnostics,
  CreateItemRequest,
  CreateItemResult,
  CreateItemSchemaCheck,
  GraphQLErrorInfo,
  IntegrationStatus,
  ItemLookup,
  MediaUploadDiagnostics,
  MediaUploadRequest,
  MediaUploadResult,
  SitecoreFailureKind,
  SitecoreLanguage,
  SitecoreSite,
  SitecoreTemplate,
  SitecoreTemplateField,
  SitecoreTreeItem,
  SitecoreTreeRoots,
} from "../types/sitecore";
import { checkMediaImage } from "../validation/file";
import type { AdapterSettings, DestinationCheck, SitecoreAdapter } from "./adapter";
import {
  buildCreateItemMutation,
  collectTemplates,
  CREATE_ITEM_INPUT_FIELDS,
  CREATE_ITEM_SCHEMA_QUERY,
  FIELD_VALUE_INPUT_FIELDS,
  INPUT_TYPE_QUERY,
  ITEM_BY_ID_QUERY,
  buildFieldReadQuery,
  CONTENT_ROOT,
  isPathWithin,
  MEDIA_ROOT,
  siteMediaFolderPath,
  toTreeItem,
  treeChildrenQuery,
  treeItemQuery,
  type TreeItemNode,
  mediaIdFromImageValue,
  namedType,
  hasRequiredRule,
  ITEM_BY_PATH_QUERY,
  joinItemPath,
  normalizeFieldType,
  parseBaseTemplateIds,
  TEMPLATE_FIELDS_QUERY,
  TEMPLATE_TREE_QUERY,
  TEMPLATE_VALIDATION_QUERY,
  toSitecoreId,
  type TreeNode,
  type TypeRef,
} from "./graphql";

// Live adapter. Uses only APIs exposed by the installed Marketplace SDK (@sitecore-marketplace-sdk/xmc):
//   - query "xmc.sites.listSites" / "xmc.sites.listLanguages"   (Sites API)
//   - mutate "xmc.authoring.graphql"                          (Authoring and Management GraphQL API)
//   - mutate "xmc.agent.assetsUploadAsset"                    (Agent API, experimental opt-in only)
// The host attaches the user's credentials, so permissions are those of the signed-in Sitecore user.

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TEMPLATES_IN_HIERARCHY = 15;

interface GraphQLPayload<T> {
  data?: T | null;
  errors?: Array<{ message?: string }>;
}

export interface SitecoreAnswerDetail {
  kind: Exclude<SitecoreFailureKind, "network" | "precondition">;
  /** "no": Sitecore rejected the request without running it. "possibly": it may have run. */
  executed: "no" | "possibly";
  status?: number;
  errors: GraphQLErrorInfo[];
}

/** Sitecore answered with an error: an HTTP error status and/or GraphQL errors. */
export class SitecoreGraphQLError extends Error {
  constructor(
    message: string,
    readonly detail: SitecoreAnswerDetail,
  ) {
    super(message);
    this.name = "SitecoreGraphQLError";
  }
}

/** No answer from Sitecore: the host or network failed, or the request timed out. */
export class SitecoreTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SitecoreTransportError";
  }
}

const MAX_ERROR_TEXT = 300;
const clip = (text: string) => (text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT - 1)}…` : text);

/** GraphQL `errors` from a response body, reduced to message, path and code. */
function graphqlErrors(body: unknown): GraphQLErrorInfo[] {
  const errors = (body as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((e: { message?: unknown; path?: unknown; extensions?: { code?: unknown } }) => ({
    message: clip(typeof e?.message === "string" ? e.message : "Unknown GraphQL error"),
    path: Array.isArray(e?.path) ? e.path.join(".") : undefined,
    code: typeof e?.extensions?.code === "string" ? e.extensions.code : undefined,
  }));
}

const SCHEMA_ERROR = /cannot query field|unknown (argument|type|field)|does not exist on (the )?type|is not defined (by|on) type|expected type|syntax error|is required but (was )?not provided|must have a selection|variable .* (is|was) not|not a valid (input|scalar)/i;
const PERMISSION_ERROR = /\b(unauthori[sz]ed|forbidden|access (is )?denied|not have (the )?(access|permission|rights?)|insufficient (rights|permissions?)|not allowed)\b/i;

/** Decides what an error answer means, and whether Sitecore could have run the request. */
export function classifyAnswer(status: number | undefined, errors: GraphQLErrorInfo[]): Pick<SitecoreAnswerDetail, "kind" | "executed"> {
  const text = errors.map((e) => `${e.message} ${e.code ?? ""}`).join(" ");
  if (status === 401 || status === 403) return { kind: "permission", executed: "no" };
  if (status === 400 || status === 404 || status === 405 || status === 415 || status === 422 || SCHEMA_ERROR.test(text) || /VALIDATION|SYNTAX|\bHC\d{4}\b/.test(text)) {
    return { kind: "schema", executed: "no" };
  }
  if (PERMISSION_ERROR.test(text)) return { kind: "permission", executed: "possibly" };
  if (status !== undefined && status >= 500) return { kind: "server", executed: "possibly" };
  return { kind: "validation", executed: "possibly" };
}

/**
 * Converts "/sitecore/media library/Project/Site" (any case) to the Agent API's "Project/Site".
 * Returns null for paths outside the Media Library or with placeholder or relative segments.
 */
export function mediaLibraryRelativePath(folderPath: string): string | null {
  const match = /^\/sitecore\/media library((?:\/[^/]+)*)\/?$/i.exec(folderPath.trim());
  if (!match) return null;
  const segments = match[1].split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((seg) => seg === "." || seg === ".." || /[<>]/.test(seg))) return null;
  return segments.join("/");
}

/** Differences between the input fields this app sends and what an input type defines. */
function compareInput(typeName: string, fields: Array<{ name: string; required: boolean }>, sent: readonly string[]): string[] {
  const problems: string[] = [];
  const unknown = sent.filter((n) => !fields.some((f) => f.name === n));
  const missingRequired = fields.filter((f) => f.required && !sent.includes(f.name)).map((f) => f.name);
  if (unknown.length) problems.push(`${typeName} has no field(s) ${unknown.join(", ")} (it has: ${fields.map((f) => f.name).join(", ")}).`);
  if (missingRequired.length) problems.push(`${typeName} requires ${missingRequired.join(", ")}, which the app does not send.`);
  return problems;
}

/** Diagnostic fields for any error thrown by graphql(). Unknown errors count as "no answer". */
function answerDetail(error: unknown): Pick<CreateDiagnostics, "kind" | "executed" | "httpStatus" | "errors" | "transportError"> {
  if (error instanceof SitecoreGraphQLError) return { kind: error.detail.kind, executed: error.detail.executed, httpStatus: error.detail.status, errors: error.detail.errors };
  return { kind: "network", executed: "possibly", errors: [], transportError: clip(describe(error)) };
}

function describeFailure(kind: CreateDiagnostics["kind"], error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  switch (kind) {
    case "network":
      return `Sitecore did not answer (${text}).`;
    case "server":
      return `Sitecore returned a server error (${text}).`;
    case "permission":
      return `Sitecore refused the request: you may not have permission to create items here (${text}).`;
    default:
      return `Sitecore could not create the item: ${text}.`;
  }
}

/** The SDK returns either { data } or { data, error } depending on the outcome. */
function requestError(result: unknown): string | null {
  if (result && typeof result === "object" && "error" in result && result.error) return describe(result.error);
  return null;
}

function describe(error: unknown): string {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  const e = error as { title?: string; detail?: string; message?: string };
  return e.detail || e.title || e.message || JSON.stringify(error);
}

/** Turns transport and permission errors into messages an author can act on. */
export function friendlySitecoreError(error: unknown): string {
  const text = describe(error);
  if (error instanceof SitecoreGraphQLError && error.detail.kind === "permission") return `You do not have permission for this operation in Sitecore (${text}).`;
  if (/\b(401|unauthori[sz]ed)\b/i.test(text)) return "Sitecore rejected the request because your session is not authorized. Reload Content Studio from Sitecore and try again.";
  if (/\b(403|forbidden|access denied|not have (the )?(access|permission))\b/i.test(text)) return `You do not have permission for this operation in Sitecore (${text}).`;
  if (/timeout|timed out/i.test(text)) return "Sitecore did not respond in time.";
  if (/\b(502|503|504)\b|unavailable/i.test(text)) return "The Sitecore environment is currently unavailable. Try again later.";
  return text;
}

function isGuidLike(value: unknown): value is string {
  return typeof value === "string" && toSitecoreId(value) !== null;
}

export class LiveSitecoreAdapter implements SitecoreAdapter {
  readonly status: IntegrationStatus;

  constructor(
    private readonly client: ClientSDK,
    private readonly sitecoreContextId: string,
    private readonly settings: AdapterSettings,
    tenantName: string,
  ) {
    this.status = {
      mode: "live",
      detail: `Connected to ${tenantName} through the Sitecore Marketplace SDK.`,
      canListSites: true,
      canDiscoverTemplates: true,
      canCreateItems: true,
      canUploadMedia: settings.experimentalMediaUpload,
    };
  }

  /**
   * Sends one Authoring GraphQL operation through the host.
   * Throws SitecoreGraphQLError when Sitecore answered with an error (HTTP error status or GraphQL
   * errors), and SitecoreTransportError when there was no answer.
   *
   * The SDK returns a hey-api result: `{ data, error, response }`. For a non-2xx answer the GraphQL
   * body is in `error` and the status in `response.status`. (ClientSDK.mutate ignores `timeoutMs`;
   * the core SDK's own 30 s request timeout applies. It is passed for forward compatibility.)
   */
  private async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let response: unknown;
    try {
      response = await this.client.mutate("xmc.authoring.graphql", {
        params: { query: { sitecoreContextId: this.sitecoreContextId }, body: { query, variables } },
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      throw new SitecoreTransportError(clip(describe(error)));
    }
    const result = response as { data?: unknown; error?: unknown; response?: { status?: unknown } } | undefined;
    const status = typeof result?.response?.status === "number" ? result.response.status : undefined;
    const payload = result?.data as GraphQLPayload<T> | undefined;
    const errors = [...graphqlErrors(payload), ...graphqlErrors(result?.error)];

    if (result?.error || (status !== undefined && status >= 400) || errors.length) {
      const message = errors.length ? errors.map((e) => e.message).join("; ") : `HTTP ${status ?? "error"}: ${clip(describe(result?.error ?? "no details"))}`;
      throw new SitecoreGraphQLError(message, { ...classifyAnswer(status, errors), status, errors });
    }
    if (!payload || typeof payload !== "object" || !payload.data) {
      throw new SitecoreGraphQLError("The Authoring API returned no data.", { kind: "unexpected-response", executed: "possibly", status, errors: [] });
    }
    return payload.data;
  }

  async listSites(): Promise<SitecoreSite[]> {
    const res = await this.client.query("xmc.sites.listSites", { params: { query: { sitecoreContextId: this.sitecoreContextId } } });
    if (res.error) throw new Error(friendlySitecoreError(res.error));
    const failure = requestError(res.data);
    if (failure) throw new Error(`Sites API request failed: ${friendlySitecoreError(failure)}`);
    const sites = res.data?.data;
    if (!Array.isArray(sites)) throw new Error("The Sites API returned an unexpected response.");
    return sites
      .filter((s) => typeof s?.id === "string" && typeof s?.name === "string")
      .map((s) => ({
        id: s.id as string,
        name: s.name as string,
        displayName: s.displayName || (s.name as string),
        languages: s.languages ?? s.supportedLanguages ?? [],
        homePageIds: (s.hosts ?? []).map((h) => h?.homePageId).filter((id): id is string => typeof id === "string" && id.length > 0),
      }));
  }

  async listLanguages(): Promise<SitecoreLanguage[]> {
    const res = await this.client.query("xmc.sites.listLanguages", { params: { query: { sitecoreContextId: this.sitecoreContextId } } });
    if (res.error) throw new Error(friendlySitecoreError(res.error));
    const failure = requestError(res.data);
    if (failure) throw new Error(`Sites API request failed: ${friendlySitecoreError(failure)}`);
    const languages = res.data?.data;
    if (!Array.isArray(languages)) throw new Error("The Sites API returned an unexpected response.");
    return languages
      .filter((l) => typeof (l?.name || l?.iso) === "string")
      .map((l) => ({ code: (l.name || l.iso) as string, name: l.englishName || l.displayName || (l.name as string) }));
  }

  async listTemplates(): Promise<SitecoreTemplate[]> {
    let data: { item: TreeNode | null };
    try {
      data = await this.graphql<{ item: TreeNode | null }>(TEMPLATE_TREE_QUERY, { path: this.settings.templateRootPath });
    } catch (error) {
      throw new Error(friendlySitecoreError(error));
    }
    if (!data.item) throw new Error(`Template root "${this.settings.templateRootPath}" was not found, or you cannot read it. Change it in Settings.`);
    // Canonical IDs, so the selected ID matches getTemplate(), validation and createItem exactly.
    return collectTemplates(data.item).flatMap((t) => {
      const id = toSitecoreId(t.id);
      return id ? [{ ...t, id, fields: [] }] : [];
    });
  }

  async getTemplate(templateId: string): Promise<SitecoreTemplate> {
    interface FieldNode {
      itemId?: string;
      name?: string;
      template?: { name?: string } | null;
      type?: { value?: string } | null;
      children?: { nodes?: FieldNode[] | null } | null;
    }
    interface TemplateNode extends FieldNode {
      path?: string;
      baseTemplates?: { value?: string } | null;
    }

    const id = toSitecoreId(templateId);
    if (!id) throw new Error("The selected template does not have a valid Sitecore ID. Select it again from the list.");
    const fields: SitecoreTemplateField[] = [];
    const notes: string[] = [];
    const seen = new Set<string>();
    const queue = [id];
    let selected: TemplateNode | null = null;
    let requiredInfo: "available" | "unavailable" = "available";

    while (queue.length && seen.size < MAX_TEMPLATES_IN_HIERARCHY) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      let node: TemplateNode | null;
      try {
        node = (await this.graphql<{ item: TemplateNode | null }>(TEMPLATE_FIELDS_QUERY, { id: current })).item;
      } catch (error) {
        if (current === id) throw new Error(friendlySitecoreError(error));
        notes.push(`A base template (${current}) could not be read, so its fields are not listed.`);
        continue;
      }
      if (!node) {
        if (current === id) throw new Error("The selected template could not be loaded, or you cannot read it.");
        notes.push(`A base template (${current}) could not be found.`);
        continue;
      }
      if (current === id) selected = node;

      let requiredNames = new Set<string>();
      try {
        requiredNames = await this.requiredFieldNames(current);
      } catch (error) {
        requiredInfo = "unavailable";
        console.warn("Content Studio: validation rules could not be read", friendlySitecoreError(error));
      }

      for (const section of node.children?.nodes ?? []) {
        if (section.template?.name !== "Template section") continue;
        for (const f of section.children?.nodes ?? []) {
          if (f.template?.name !== "Template field" || !f.name || fields.some((x) => x.name === f.name)) continue;
          const required = requiredNames.has(f.name);
          fields.push({
            name: f.name,
            id: f.itemId ? (toSitecoreId(f.itemId) ?? undefined) : undefined,
            rawType: f.type?.value,
            type: normalizeFieldType(f.type?.value),
            required,
            requiredSource: required ? "validation-rule" : undefined,
            section: section.name,
            definedIn: current === id ? undefined : node.name,
          });
        }
      }
      queue.push(...parseBaseTemplateIds(node.baseTemplates?.value));
    }
    if (queue.some((q) => !seen.has(q))) notes.push(`Only the first ${MAX_TEMPLATES_IN_HIERARCHY} templates of the inheritance chain were read.`);

    return { id, name: selected?.name ?? templateId, path: selected?.path, fields, requiredInfo, notes };
  }

  private async requiredFieldNames(templateId: string): Promise<Set<string>> {
    interface RuleNode {
      name?: string;
      template?: { name?: string } | null;
      quickAction?: { value?: string } | null;
      validateButton?: { value?: string } | null;
      validatorBar?: { value?: string } | null;
      workflow?: { value?: string } | null;
      children?: { nodes?: RuleNode[] | null } | null;
    }
    const data = await this.graphql<{ item: RuleNode | null }>(TEMPLATE_VALIDATION_QUERY, { id: templateId });
    const names = new Set<string>();
    for (const section of data.item?.children?.nodes ?? []) {
      for (const f of section.children?.nodes ?? []) {
        if (f.name && hasRequiredRule([f.quickAction?.value, f.validateButton?.value, f.validatorBar?.value, f.workflow?.value])) names.add(f.name);
      }
    }
    return names;
  }

  /**
   * After a confirmed creation, reads the Image fields back and compares the referenced media item
   * with what was sent. Differences become warnings; the item itself was created either way.
   */
  private async checkImageFields(
    result: Extract<CreateItemResult, { ok: true }>,
    request: CreateItemRequest,
    diagnostics: CreateDiagnostics,
  ): Promise<CreateItemResult> {
    const images = request.fields.filter((f) => f.type === "Image");
    if (images.length === 0) return result;
    const warnings = [...(result.warnings ?? [])];
    try {
      const data = await this.graphql<{ item: Record<string, { value?: string } | null> | null }>(buildFieldReadQuery(images.map((f) => f.name)), { id: toSitecoreId(result.itemId) ?? result.itemId, language: request.language });
      const fieldCheck = images.map((f, i) => {
        const saved = data.item?.[`f${i}`]?.value ?? null;
        const match = mediaIdFromImageValue(saved) !== null && mediaIdFromImageValue(saved) === mediaIdFromImageValue(f.value);
        if (!match) warnings.push(`Image field "${f.name}" was not saved as sent (Sitecore has: ${saved ? clip(saved) : "empty"}). Check the field in the Content Editor.`);
        return { name: f.name, sent: f.value, saved, match };
      });
      return { ...result, warnings: warnings.length ? warnings : undefined, diagnostics: { ...diagnostics, fieldCheck } };
    } catch (error) {
      warnings.push(`The item was created, but its image field(s) could not be read back (${friendlySitecoreError(error)}). Check them in the Content Editor.`);
      return { ...result, warnings, diagnostics };
    }
  }

  async findItemById(id: string): Promise<ItemLookup> {
    const itemId = toSitecoreId(id);
    if (!itemId) return { found: false };
    const data = await this.graphql<{ item: { itemId?: string; path?: string } | null }>(ITEM_BY_ID_QUERY, { id: itemId });
    if (!data.item) return { found: false };
    if (!isGuidLike(data.item.itemId) || typeof data.item.path !== "string") throw new Error("The Authoring API returned an unexpected item.");
    return { found: true, itemId: data.item.itemId, path: data.item.path };
  }

  async findItem(path: string): Promise<ItemLookup> {
    const data = await this.graphql<{ item: { itemId?: string; path?: string } | null }>(ITEM_BY_PATH_QUERY, { path });
    if (!data.item) return { found: false };
    if (!isGuidLike(data.item.itemId) || typeof data.item.path !== "string") throw new Error("The Authoring API returned an unexpected item.");
    return { found: true, itemId: data.item.itemId, path: data.item.path };
  }

  async checkDestination(path: string): Promise<DestinationCheck> {
    try {
      const item = await this.findItem(path);
      if (!item.found) return { ok: false, message: `No item exists at "${path}", or you do not have access to it.` };
      return { ok: true, itemId: item.itemId, path: item.path };
    } catch (error) {
      return { ok: false, message: friendlySitecoreError(error) };
    }
  }

  /** Set once the tenant rejected the full tree field set (hasChildren, displayName). */
  private basicTreeFields = false;

  /** Runs a tree query, retrying once with the basic field set if the schema lacks the optional fields. */
  private async treeQuery<T>(build: (basic: boolean) => string, key: string): Promise<T> {
    try {
      return await this.graphql<T>(build(this.basicTreeFields), { key });
    } catch (error) {
      if (this.basicTreeFields || !(error instanceof SitecoreGraphQLError) || error.detail.kind !== "schema") throw error;
      this.basicTreeFields = true;
      return this.graphql<T>(build(true), { key });
    }
  }

  private async treeItem(by: "path" | "id", key: string): Promise<SitecoreTreeItem | null> {
    const data = await this.treeQuery<{ item: TreeItemNode | null }>((basic) => treeItemQuery(by, basic), key);
    return toTreeItem(data.item);
  }

  async getChildren(path: string): Promise<SitecoreTreeItem[]> {
    let data: { item: { children?: { nodes?: TreeItemNode[] | null } | null } | null };
    try {
      data = await this.treeQuery(treeChildrenQuery, path);
    } catch (error) {
      throw new Error(friendlySitecoreError(error));
    }
    if (!data.item) throw new Error(`"${path}" was not found, or you cannot read it.`);
    return (data.item.children?.nodes ?? []).map(toTreeItem).filter((item): item is SitecoreTreeItem => item !== null);
  }

  /**
   * The site's root item: the item with the site's ID (the Sites API uses the site item's ID), or
   * else the parent of one of its home pages. Null when neither resolves to an item below /sitecore/content.
   */
  private async siteRoot(site: SitecoreSite): Promise<SitecoreTreeItem | null> {
    const below = (item: SitecoreTreeItem | null) => (item && isPathWithin(item.path, CONTENT_ROOT) && !isPathWithin(CONTENT_ROOT, item.path) ? item : null);
    const siteItemId = toSitecoreId(site.id);
    const direct = siteItemId ? below(await this.treeItem("id", siteItemId)) : null;
    if (direct) return direct;
    for (const homeId of site.homePageIds ?? []) {
      const id = toSitecoreId(homeId);
      const home = id ? below(await this.treeItem("id", id)) : null;
      if (!home) continue;
      const parent = below(await this.treeItem("path", home.path.replace(/\/[^/]+$/, "")));
      if (parent) return parent;
    }
    return null;
  }

  async getTreeRoots(site: SitecoreSite | undefined): Promise<SitecoreTreeRoots> {
    const notes: string[] = [];
    try {
      const siteRoot = site ? await this.siteRoot(site) : null;
      if (site && !siteRoot) notes.push(`The root item of "${site.displayName}" could not be found, so the tree starts at ${CONTENT_ROOT}.`);
      const content = siteRoot ?? (await this.treeItem("path", CONTENT_ROOT));
      const media = await this.treeItem("path", MEDIA_ROOT);
      if (!content || !media) throw new Error(`${content ? MEDIA_ROOT : CONTENT_ROOT} could not be read. You may not have access to it.`);
      const mediaPath = siteRoot ? siteMediaFolderPath(siteRoot.path) : null;
      // A missing or unreadable site media folder is reported by the upload panel, not as an error here.
      const mediaFolder = mediaPath ? ((await this.treeItem("path", mediaPath).catch(() => null)) ?? undefined) : undefined;
      return { content, media, mediaFolder, notes };
    } catch (error) {
      throw new Error(friendlySitecoreError(error));
    }
  }

  async createItem(request: CreateItemRequest): Promise<CreateItemResult> {
    const templateId = toSitecoreId(request.templateId);
    const diag = (stage: CreateDiagnostics["stage"], parent: string | null, extra: Partial<CreateDiagnostics> = {}): CreateDiagnostics => ({
      operation: "ContentStudioCreateItem",
      stage,
      executed: "no",
      errors: [],
      // Structure only: field names and value lengths, never values.
      input: {
        name: request.name,
        templateId: templateId ?? request.templateId,
        parent,
        parentPath: request.parentPath,
        language: request.language,
        fields: request.fields.map((f) => ({
          name: f.name,
          length: f.value.length,
          ...(f.type ? { type: f.type } : {}),
          ...(f.fieldId ? { fieldId: f.fieldId } : {}),
          // Image values are media references, not document content.
          ...(f.type === "Image" ? { value: f.value } : {}),
        })),
      },
      at: new Date().toISOString(),
      ...extra,
    });
    const report = <R extends CreateItemResult>(result: R): R => {
      if ("diagnostics" in result && result.diagnostics && !result.ok) console.warn("Content Studio: item creation did not succeed", result.diagnostics);
      return result;
    };

    // Preflight. Failures here are definite: nothing that could create content has been sent.
    if (!templateId) {
      return report({ ok: false, reason: "error", kind: "precondition", message: "The selected template ID is not a valid Sitecore ID.", diagnostics: diag("preflight", null, { kind: "precondition" }) });
    }
    const parent = await this.checkDestination(request.parentPath);
    if (!parent.ok) return report({ ok: false, reason: "error", kind: "precondition", message: parent.message, diagnostics: diag("preflight", null, { kind: "precondition" }) });
    const parentId = toSitecoreId(parent.itemId) ?? parent.itemId;
    const targetPath = joinItemPath(parent.path, request.name);
    try {
      if ((await this.findItem(targetPath)).found) {
        return report({ ok: false, reason: "error", kind: "precondition", message: `An item named "${request.name}" already exists under ${parent.path}. Choose a different item name.`, diagnostics: diag("duplicate-check", parentId, { kind: "precondition" }) });
      }
    } catch (error) {
      return report({ ok: false, reason: "error", kind: "precondition", message: `The destination could not be checked for duplicates: ${friendlySitecoreError(error)}`, diagnostics: diag("duplicate-check", parentId, answerDetail(error)) });
    }

    const mutation = buildCreateItemMutation({ ...request, templateId, parentId });
    let data: { createItem?: { item?: { itemId?: string; path?: string } | null } | null };
    try {
      data = await this.graphql(mutation.query);
    } catch (error) {
      const detail = answerDetail(error);
      const sent = diag("mutation", parentId, detail);
      if (detail.executed === "no") {
        // Rejected before execution (schema, authorization): nothing was created.
        const message =
          detail.kind === "permission"
            ? `Sitecore refused the request: you are not authorized to create items here (${error instanceof Error ? error.message : "permission denied"}). Nothing was created.`
            : `Sitecore rejected the request before running it, so nothing was created: ${error instanceof Error ? error.message : String(error)}`;
        return report({ ok: false, reason: "error", kind: detail.kind, message, diagnostics: sent });
      }
      // Sitecore may have run it. Look it up instead of guessing; never re-send.
      let lookup: ItemLookup;
      try {
        lookup = await this.findItem(targetPath);
      } catch {
        return report({
          ok: false,
          reason: "uncertain",
          kind: detail.kind,
          message: `${describeFailure(detail.kind, error)} The item could not be looked up afterwards, so it may or may not exist. Use Check in Sitecore before trying again.`,
          diagnostics: { ...sent, stage: "verification" },
        });
      }
      if (lookup.found) {
        const warning = detail.kind === "network" ? "Sitecore did not answer in time; the item was confirmed by looking it up." : `Sitecore reported: ${error instanceof Error ? error.message : String(error)}`;
        return this.checkImageFields({ ok: true, itemId: lookup.itemId, path: lookup.path, warnings: [warning] }, request, { ...sent, stage: "verification", executed: "yes" });
      }
      if (detail.kind === "network") {
        // No answer and no item yet: the request may still be processing in Sitecore.
        return report({
          ok: false,
          reason: "uncertain",
          kind: "network",
          message: `${describeFailure("network", error)} The item does not exist yet, but the request may still be processing. Wait a minute, then use Check in Sitecore. Do not create it again until it is resolved.`,
          diagnostics: { ...sent, stage: "verification" },
        });
      }
      // Sitecore answered with an error and the item does not exist: a definite failure.
      return report({ ok: false, reason: "error", kind: detail.kind, message: `${describeFailure(detail.kind, error)} Sitecore confirmed that no item was created.`, diagnostics: { ...sent, stage: "verification" } });
    }

    const item = data.createItem?.item;
    if (item && isGuidLike(item.itemId) && typeof item.path === "string") return this.checkImageFields({ ok: true, itemId: item.itemId, path: item.path }, request, diag("verification", parentId, { executed: "yes" }));
    // A response without a usable item: verify instead of guessing.
    const odd = diag("verification", parentId, { kind: "unexpected-response", executed: "possibly" });
    try {
      const created = await this.findItem(targetPath);
      if (created.found) return this.checkImageFields({ ok: true, itemId: created.itemId, path: created.path }, request, { ...odd, executed: "yes" });
      return report({ ok: false, reason: "error", kind: "unexpected-response", message: "Sitecore did not return the new item, and it does not exist.", diagnostics: odd });
    } catch {
      return report({ ok: false, reason: "uncertain", kind: "unexpected-response", message: "Sitecore returned an unexpected response and the result could not be checked. Use Check in Sitecore.", diagnostics: odd });
    }
  }

  /**
   * Read-only: checks via GraphQL introspection that the tenant's createItem mutation accepts the
   * inputs this app sends (and requires nothing else). Sends no mutation.
   */
  async inspectCreateItemSchema(): Promise<CreateItemSchemaCheck> {
    interface MutationField {
      name?: string;
      args?: Array<{ name?: string; type?: TypeRef }> | null;
    }
    let mutations: MutationField[];
    try {
      const data = await this.graphql<{ __schema?: { mutationType?: { fields?: MutationField[] | null } | null } | null }>(CREATE_ITEM_SCHEMA_QUERY);
      mutations = data.__schema?.mutationType?.fields ?? [];
    } catch (error) {
      return { status: "unavailable", detail: `Schema introspection is not available (${friendlySitecoreError(error)}). Check createItem in the GraphQL IDE instead.` };
    }
    const create = mutations.find((f) => f.name === "createItem");
    if (!create) return { status: "mismatch", detail: "The Authoring API schema has no createItem mutation." };
    const inputType = namedType(create.args?.find((a) => a.name === "input")?.type);
    if (!inputType) return { status: "mismatch", detail: `createItem has no "input" argument (arguments: ${(create.args ?? []).map((a) => a.name).join(", ") || "none"}).` };

    const input = await this.inputFields(inputType);
    if (!input) return { status: "unavailable", detail: `The input type ${inputType} could not be read.` };
    const problems = compareInput(inputType, input, CREATE_ITEM_INPUT_FIELDS);
    const fieldsType = input.find((f) => f.name === "fields")?.typeName;
    if (fieldsType) {
      const fieldValue = await this.inputFields(fieldsType);
      if (!fieldValue) return { status: "unavailable", detail: `The input type ${fieldsType} could not be read.` };
      problems.push(...compareInput(fieldsType, fieldValue, FIELD_VALUE_INPUT_FIELDS));
    }
    if (problems.length) return { status: "mismatch", detail: problems.join(" ") };
    return { status: "match", detail: `createItem(input: ${inputType}) accepts ${CREATE_ITEM_INPUT_FIELDS.join(", ")}; fields are ${fieldsType ?? "?"} { name, value }.` };
  }

  private async inputFields(typeName: string): Promise<Array<{ name: string; required: boolean; typeName?: string }> | null> {
    interface InputField {
      name?: string;
      defaultValue?: string | null;
      type?: TypeRef;
    }
    try {
      const data = await this.graphql<{ __type?: { inputFields?: InputField[] | null } | null }>(INPUT_TYPE_QUERY, { name: typeName });
      const fields = data.__type?.inputFields;
      if (!Array.isArray(fields)) return null;
      return fields
        .filter((f): f is InputField & { name: string } => typeof f.name === "string")
        .map((f) => ({ name: f.name, required: f.type?.kind === "NON_NULL" && (f.defaultValue === null || f.defaultValue === undefined), typeName: namedType(f.type) }));
    } catch {
      return null;
    }
  }

  /**
   * Uploads one image through the Agent API (xmc.agent.assetsUploadAsset, POST /api/v1/assets/upload,
   * multipart "file" + "upload_request" JSON). Success requires `success: true` and a GUID media item
   * ID; the item is then looked up by ID to confirm it exists and to record its path.
   */
  async uploadMedia(request: MediaUploadRequest): Promise<MediaUploadResult> {
    const extension = request.extension.replace(/^\./, "").toLowerCase();
    const fileName = `${request.name}.${extension}`;
    const diagnostics: MediaUploadDiagnostics = {
      operation: "xmc.agent.assetsUploadAsset",
      imageId: request.imageId,
      fileName,
      mimeType: request.mimeType,
      size: request.file.size,
      folderPath: request.folderPath,
      verified: "not-checked",
      at: new Date().toISOString(),
    };
    const fail = (reason: "error" | "uncertain", message: string): MediaUploadResult => {
      console.warn("Content Studio: media upload did not succeed", diagnostics);
      return { ok: false, reason, message, diagnostics: { ...diagnostics, error: clip(message) } };
    };

    if (!this.status.canUploadMedia) return fail("error", "Media upload is not enabled.");
    const invalid = checkMediaImage(request.mimeType, request.file.size);
    if (invalid) return fail("error", invalid);
    if (!/^[\w\s-]+$/.test(request.name) || !/^[a-z0-9]+$/.test(extension)) return fail("error", "The image name or extension is not valid for the Media Library.");
    const itemPath = mediaLibraryRelativePath(request.folderPath);
    if (itemPath === null) return fail("error", "The folder must be an existing folder under /sitecore/media library.");
    diagnostics.itemPath = itemPath;

    // Read-only check first, so a wrong folder is reported clearly and nothing is sent.
    try {
      const folder = await this.findItem(request.folderPath.trim().replace(/\/+$/, ""));
      if (!folder.found) {
        return fail("error", `The Media Library folder "${request.folderPath}" does not exist, or you cannot access it. Create it in the Media Library or choose another folder.`);
      }
    } catch (error) {
      return fail("error", `The Media Library folder could not be checked: ${friendlySitecoreError(error)}`);
    }

    // A named File, so the multipart part carries the file name and type (a bare Blob is sent as "blob").
    const file = new File([request.file], fileName, { type: request.mimeType });
    let response: unknown;
    try {
      response = await this.client.mutate("xmc.agent.assetsUploadAsset", {
        params: {
          query: { sitecoreContextId: this.sitecoreContextId },
          body: {
            file,
            // Field set and "name" example ("example.jpg") from the SDK's UploadAssetRequest description.
            // itemPath is relative to the Media Library root: the tenant prefixes "/sitecore/Media Library/"
            // itself (an absolute path produced "/sitecore/Media Library//sitecore/media library/…" not found).
            upload_request: JSON.stringify({ name: fileName, itemPath, language: request.language, extension, siteName: request.siteName }),
          },
        },
        timeoutMs: 60_000,
      });
    } catch (error) {
      return fail("uncertain", `No reliable answer from Sitecore (${friendlySitecoreError(error)}). The image may or may not have been uploaded; check the Media Library before retrying.`);
    }

    const answer = response as { data?: unknown; error?: unknown; response?: { status?: unknown } } | undefined;
    diagnostics.httpStatus = typeof answer?.response?.status === "number" ? answer.response.status : undefined;
    const failure = requestError(answer);
    if (failure) return fail("error", `Sitecore rejected the upload: ${friendlySitecoreError(failure)}`);

    const result = answer?.data as { success?: unknown; mediaItem?: { id?: unknown; embedUrl?: unknown } } | undefined;
    diagnostics.success = typeof result?.success === "boolean" ? result.success : null;
    diagnostics.returnedId = typeof result?.mediaItem?.id === "string" ? result.mediaItem.id : null;
    const mediaItemId = typeof result?.mediaItem?.id === "string" ? toSitecoreId(result.mediaItem.id) : null;
    if (result?.success !== true || !mediaItemId) {
      return fail("error", result?.success === true ? "Sitecore reported success but returned no valid media item ID, so the image cannot be referenced." : "Sitecore did not confirm the upload.");
    }
    const embedUrl = typeof result.mediaItem?.embedUrl === "string" ? result.mediaItem.embedUrl : undefined;

    // Confirm the media item exists and record its path.
    try {
      const item = await this.findItemById(mediaItemId);
      if (!item.found) {
        diagnostics.verified = "no";
        return fail("uncertain", `Sitecore returned media item ${mediaItemId}, but it cannot be found. Check the Media Library before using or retrying this image.`);
      }
      diagnostics.verified = "yes";
      diagnostics.mediaPath = item.path;
      const warnings = item.path.toLowerCase().startsWith(request.folderPath.toLowerCase().replace(/\/+$/, "") + "/") ? [] : [`The media item was stored at ${item.path}, not under ${request.folderPath}.`];
      return { ok: true, mediaItemId, mediaPath: item.path, embedUrl, warnings, diagnostics };
    } catch (error) {
      // The upload itself was confirmed with an ID; only the extra check could not run.
      return { ok: true, mediaItemId, embedUrl, warnings: [`The media item could not be looked up (${friendlySitecoreError(error)}).`], diagnostics };
    }
  }
}
