import type { CreateItemRequest, GraphQLRequestPreview, SitecoreFieldType, SitecoreTreeItem } from "../types/sitecore";

// Authoring and Management GraphQL operations used by the live adapter.
// They are sent through the Marketplace SDK mutation "xmc.authoring.graphql", which attaches
// the signed-in user's token on the host side; this app never handles tokens.
//
// Operations follow the documented examples ("Query examples for authoring operations"):
//   item(where: { database, path | itemId }) { itemId name path ... }
//   createItem(input: { name, templateId, parent, language, fields: [{ name, value }] })
// `children { nodes { ... } }` and `field(name:) { value }` are used to read template
// definitions. These must be confirmed in the tenant's GraphQL IDE (see README checklist).

/** GraphQL string literal. JSON string escaping is valid GraphQL string escaping. */
const lit = (value: string) => JSON.stringify(value);

/** The Sitecore "Standard template" every template inherits; its fields are system fields. */
export const STANDARD_TEMPLATE_ID = "{1930BBEB-7805-4B14-BB77-F2D7EE5A5B37}";
/** The "Required" field validation rule (/sitecore/system/Settings/Validation Rules/Field Rules/Required). */
export const REQUIRED_VALIDATOR_ID = "{59D4EE10-627C-4FD3-A964-61A88B092CBC}";

/** Normalizes a Sitecore ID ("110d559f...", "110D559F-DEA5-...", "{...}") to "{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}". */
export function toSitecoreId(id: string): string | null {
  const hex = id.replace(/[{}-]/g, "").trim();
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  const h = hex.toUpperCase();
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`;
}

/**
 * Compares two item IDs regardless of format (braces, dashes, case). The Authoring API and this
 * app can spell the same GUID differently. Non-GUID IDs (demo data) are compared as-is.
 */
export function sameSitecoreId(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const na = toSitecoreId(a);
  const nb = toSitecoreId(b);
  return na !== null && nb !== null ? na === nb : a === b;
}

export function joinItemPath(parent: string, name: string): string {
  return `${parent.replace(/\/+$/, "")}/${name}`;
}

export const ITEM_BY_PATH_QUERY = `query ContentStudioItemByPath($path: String!) {
  item(where: { database: "master", path: $path }) { itemId name path }
}`;

export const ITEM_BY_ID_QUERY = `query ContentStudioItemById($id: ID!) {
  item(where: { database: "master", itemId: $id }) { itemId name path }
}`;

export const CONTENT_ROOT = "/sitecore/content";
export const MEDIA_ROOT = "/sitecore/media library";

// Tree browsing (read-only). `hasChildren` and `displayName` are requested when the schema has them;
// the live adapter falls back to the basic field set if the tenant rejects them.
const TREE_FIELDS = "itemId name displayName path hasChildren template { name }";
const TREE_FIELDS_BASIC = "itemId name path template { name }";

export function treeItemQuery(by: "path" | "id", basic = false): string {
  const where = by === "path" ? "path: $key" : "itemId: $key";
  return `query ContentStudioTreeItem($key: ${by === "path" ? "String" : "ID"}!) {
  item(where: { database: "master", ${where} }) { ${basic ? TREE_FIELDS_BASIC : TREE_FIELDS} }
}`;
}

export function treeChildrenQuery(basic = false): string {
  return `query ContentStudioTreeChildren($key: String!) {
  item(where: { database: "master", path: $key }) { children { nodes { ${basic ? TREE_FIELDS_BASIC : TREE_FIELDS} } } }
}`;
}

export interface TreeItemNode {
  itemId?: string;
  name?: string;
  displayName?: string | null;
  path?: string;
  hasChildren?: boolean | null;
  template?: { name?: string } | null;
}

/** A tree item from an Authoring API node, or null when the node lacks an ID, name or path. */
export function toTreeItem(node: TreeItemNode | null | undefined): SitecoreTreeItem | null {
  const id = node?.itemId ? toSitecoreId(node.itemId) : null;
  if (!node || !id || typeof node.name !== "string" || typeof node.path !== "string") return null;
  return {
    id,
    name: node.name,
    displayName: node.displayName && node.displayName !== node.name ? node.displayName : undefined,
    path: node.path,
    hasChildren: typeof node.hasChildren === "boolean" ? node.hasChildren : undefined,
    templateName: node.template?.name,
  };
}

/** True when `path` is `root` or below it (case-insensitive, as Sitecore paths are). */
export function isPathWithin(path: string, root: string): boolean {
  const p = path.toLowerCase().replace(/\/+$/, "");
  const r = root.toLowerCase().replace(/\/+$/, "");
  return p === r || p.startsWith(`${r}/`);
}

/**
 * The media folder that belongs to a site: a site at /sitecore/content/<collection>/<site> keeps its
 * media in /sitecore/media library/Project/<collection>/<site> (the SitecoreAI / SXA layout). Only
 * that exact folder counts, so other sites' folders are never offered. Null outside /sitecore/content.
 */
export function siteMediaFolderPath(siteRootPath: string): string | null {
  const segments = siteRootPath.split("/").filter(Boolean).slice(2);
  if (!isPathWithin(siteRootPath, CONTENT_ROOT) || segments.length === 0) return null;
  return `${MEDIA_ROOT}/Project/${segments.join("/")}`;
}

/**
 * Reads named fields of one item version. Used after creation to confirm what Sitecore stored.
 * Field names are passed as GraphQL string literals with aliases f0, f1, …
 */
export function buildFieldReadQuery(fieldNames: string[]): string {
  const fields = fieldNames.map((n, i) => `f${i}: field(name: ${lit(n)}) { value }`).join("\n    ");
  return `query ContentStudioReadFields($id: ID!, $language: String!) {
  item(where: { database: "master", itemId: $id, language: $language }) {
    ${fields}
  }
}`;
}

/**
 * Raw value of a Sitecore Image field: an XML element referencing the media item by its braced ID,
 * the format the Content Editor stores (e.g. <image mediaid="{…}" />). A bare GUID, path or URL is
 * not a valid Image field value.
 */
export function toImageFieldValue(mediaItemId: string): string | null {
  const id = toSitecoreId(mediaItemId);
  return id ? `<image mediaid="${id}" />` : null;
}

/** The media item ID referenced by an Image field value, or null. */
export function mediaIdFromImageValue(value: string | null | undefined): string | null {
  const match = /mediaid\s*=\s*"([^"]+)"/i.exec(value ?? "");
  return match ? toSitecoreId(match[1]) : null;
}

/** Template root -> folders -> templates, three levels deep. */
export const TEMPLATE_TREE_QUERY = `query ContentStudioTemplateTree($path: String!) {
  item(where: { database: "master", path: $path }) {
    itemId name path template { name }
    children { nodes { itemId name path template { name }
      children { nodes { itemId name path template { name }
        children { nodes { itemId name path template { name } } }
      } }
    } }
  }
}`;

/** Template definition item -> base templates, sections -> field definition items with their "Type" field. */
export const TEMPLATE_FIELDS_QUERY = `query ContentStudioTemplateFields($id: ID!) {
  item(where: { database: "master", itemId: $id }) {
    itemId name path
    baseTemplates: field(name: "__Base template") { value }
    children { nodes { name template { name }
      children { nodes { itemId name template { name } type: field(name: "Type") { value } } }
    } }
  }
}`;

/**
 * Validation rules assigned to the template's field definition items. Loaded separately and
 * optionally: if this query fails, required-field information is reported as unavailable.
 */
export const TEMPLATE_VALIDATION_QUERY = `query ContentStudioTemplateValidation($id: ID!) {
  item(where: { database: "master", itemId: $id }) {
    children { nodes { template { name }
      children { nodes { name template { name }
        quickAction: field(name: "__Quick Action Bar Validation Rules") { value }
        validateButton: field(name: "__Validate Button Validation Rules") { value }
        validatorBar: field(name: "__Validator Bar Validation Rules") { value }
        workflow: field(name: "__Workflow Validation Rules") { value }
      } }
    } }
  }
}`;

/** The createItem input fields this app sends, and the fields of each entry in `fields`. */
export const CREATE_ITEM_INPUT_FIELDS = ["name", "templateId", "parent", "language", "fields"] as const;
export const FIELD_VALUE_INPUT_FIELDS = ["name", "value"] as const;

const TYPE_REF = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";

/** Read-only introspection: the arguments of the createItem mutation. */
export const CREATE_ITEM_SCHEMA_QUERY = `query ContentStudioCreateItemSchema {
  __schema { mutationType { fields { name args { name type { ${TYPE_REF} } } } } }
}`;

/** Read-only introspection: the fields of an input type. */
export const INPUT_TYPE_QUERY = `query ContentStudioInputType($name: String!) {
  __type(name: $name) { name kind inputFields { name defaultValue type { ${TYPE_REF} } } }
}`;

export interface TypeRef {
  kind?: string;
  name?: string | null;
  ofType?: TypeRef | null;
}

/** The named type inside NON_NULL / LIST wrappers. */
export function namedType(ref: TypeRef | null | undefined): string | undefined {
  let current = ref;
  while (current && !current.name && current.ofType) current = current.ofType;
  return current?.name ?? undefined;
}

export function buildCreateItemMutation(request: CreateItemRequest & { parentId: string }): GraphQLRequestPreview {
  const fields = request.fields.map((f) => `{ name: ${lit(f.name)}, value: ${lit(f.value)} }`).join(", ");
  const query = `mutation ContentStudioCreateItem {
  createItem(input: {
    name: ${lit(request.name)}
    templateId: ${lit(toSitecoreId(request.templateId) ?? request.templateId)}
    parent: ${lit(toSitecoreId(request.parentId) ?? request.parentId)}
    language: ${lit(request.language)}
    fields: [${fields}]
  }) { item { itemId name path } }
}`;
  return { query, variables: {} };
}

const REFERENCE_TYPES = new Set([
  "droplink", "droptree", "droplist", "grouped droplink", "grouped droplist", "multilist", "multilist with search",
  "treelist", "treelistex", "treelist with search", "checklist", "multiroot treelist", "name lookup value list", "tags",
]);

export function normalizeFieldType(raw: string | undefined): SitecoreFieldType {
  const type = (raw ?? "").trim().toLowerCase();
  switch (type) {
    case "single-line text":
      return "Single-Line Text";
    case "multi-line text":
      return "Multi-Line Text";
    case "rich text":
      return "Rich Text";
    case "image":
      return "Image";
    case "general link":
    case "general link with search":
      return "General Link";
    case "date":
      return "Date";
    case "datetime":
      return "Datetime";
    case "checkbox":
      return "Checkbox";
    case "integer":
    case "number":
      return "Number";
    default:
      return REFERENCE_TYPES.has(type) ? "Reference" : "Other";
  }
}

/** Parses the pipe-separated "__Base template" value, excluding the Standard template. */
export function parseBaseTemplateIds(value: string | null | undefined): string[] {
  return (value ?? "")
    .split("|")
    .map((id) => toSitecoreId(id))
    .filter((id): id is string => id !== null && id !== STANDARD_TEMPLATE_ID);
}

/** True if any validation rule list of a field definition contains the "Required" rule. */
export function hasRequiredRule(values: Array<string | null | undefined>): boolean {
  return values.some((v) => (v ?? "").split("|").some((id) => toSitecoreId(id) === REQUIRED_VALIDATOR_ID));
}

export interface TreeNode {
  itemId?: string;
  name?: string;
  path?: string;
  template?: { name?: string } | null;
  children?: { nodes?: TreeNode[] | null } | null;
}

export function collectTemplates(root: TreeNode | null | undefined): Array<{ id: string; name: string; path: string }> {
  const out: Array<{ id: string; name: string; path: string }> = [];
  const walk = (node: TreeNode | null | undefined) => {
    if (!node) return;
    if (node.template?.name === "Template" && node.itemId && node.name) {
      out.push({ id: node.itemId, name: node.name, path: node.path ?? "" });
    }
    node.children?.nodes?.forEach(walk);
  };
  walk(root);
  return out;
}
