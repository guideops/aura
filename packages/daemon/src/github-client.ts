import { graphql } from "@octokit/graphql";
import type { GitHubProjectClient, RemoteItem, ColumnMapping } from "./github-sync.js";
import { DEFAULT_MAPPING } from "./github-sync.js";
import type { CardStatus } from "@aura/core";

/**
 * Octokit GraphQL transport for GitHub Projects v2.
 *
 * NOTE: This is network code that requires a real token + project, so it is
 * not exercised by the unit suite (the reconcile logic it feeds IS, heavily).
 * Keep it thin: fetch/map/mutate only, no business logic. All conflict and
 * convergence decisions live in github-sync.ts.
 */
export interface GitHubClientConfig {
  token: string;
  projectId: string; // Projects v2 node id (PVT_...)
  mapping?: ColumnMapping;
}

interface StatusField {
  fieldId: string;
  optionIdByName: Map<string, string>;
  nameByOptionId: Map<string, string>;
}

export class OctokitProjectClient implements GitHubProjectClient {
  private gql: typeof graphql;
  private mapping: ColumnMapping;
  private statusField: StatusField | null = null;

  constructor(private config: GitHubClientConfig) {
    this.gql = graphql.defaults({ headers: { authorization: `token ${config.token}` } });
    this.mapping = config.mapping ?? DEFAULT_MAPPING;
  }

  /** Resolves the Status single-select field id + its option ids (cached). */
  private async ensureStatusField(): Promise<StatusField> {
    if (this.statusField) return this.statusField;
    const data = await this.gql<{ node: { fields: { nodes: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }> } } }>(
      `query($id: ID!) {
        node(id: $id) { ... on ProjectV2 {
          fields(first: 50) { nodes {
            ... on ProjectV2SingleSelectField { id name options { id name } }
          } }
        } }
      }`,
      { id: this.config.projectId },
    );
    const field = data.node.fields.nodes.find((f) => f.name === "Status" && f.options);
    if (!field?.options) throw new Error("Project has no 'Status' single-select field");
    const optionIdByName = new Map<string, string>();
    const nameByOptionId = new Map<string, string>();
    for (const o of field.options) { optionIdByName.set(o.name, o.id); nameByOptionId.set(o.id, o.name); }
    this.statusField = { fieldId: field.id, optionIdByName, nameByOptionId };
    return this.statusField;
  }

  async listItems(): Promise<RemoteItem[]> {
    const sf = await this.ensureStatusField();
    const items: RemoteItem[] = [];
    let cursor: string | null = null;
    do {
      const data: any = await this.gql(
        `query($id: ID!, $cursor: String) {
          node(id: $id) { ... on ProjectV2 {
            items(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                content { ... on DraftIssue { title } ... on Issue { title } ... on PullRequest { title } }
                fieldValues(first: 20) { nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2SingleSelectField { name } } }
                } }
              }
            }
          } }
        }`,
        { id: this.config.projectId, cursor },
      );
      const conn = data.node.items;
      for (const node of conn.nodes) {
        const statusVal = node.fieldValues.nodes.find((v: any) => v?.field?.name === "Status");
        const optionName = statusVal ? sf.nameByOptionId.get(statusVal.optionId) : undefined;
        const status = (optionName && this.mapping.optionToStatus[optionName]) || "backlog";
        items.push({ externalId: node.id, title: node.content?.title ?? "(untitled)", status });
      }
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor);
    return items;
  }

  async updateItemStatus(externalId: string, status: CardStatus): Promise<void> {
    const sf = await this.ensureStatusField();
    const optionId = sf.optionIdByName.get(this.mapping.statusToOption[status]);
    if (!optionId) throw new Error(`No GitHub option for status ${status}`);
    await this.gql(
      `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $project, itemId: $item, fieldId: $field,
          value: { singleSelectOptionId: $option }
        }) { projectV2Item { id } }
      }`,
      { project: this.config.projectId, item: externalId, field: sf.fieldId, option: optionId },
    );
  }

  async createItem(title: string, status: CardStatus): Promise<RemoteItem> {
    const data = await this.gql<{ addProjectV2DraftIssue: { projectItem: { id: string } } }>(
      `mutation($project: ID!, $title: String!) {
        addProjectV2DraftIssue(input: { projectId: $project, title: $title }) {
          projectItem { id }
        }
      }`,
      { project: this.config.projectId, title },
    );
    const externalId = data.addProjectV2DraftIssue.projectItem.id;
    await this.updateItemStatus(externalId, status);
    return { externalId, title, status };
  }
}
