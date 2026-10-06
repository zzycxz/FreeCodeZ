// ============================================================
// MCP 目录态 A/B 实验台：工具面与任务集（数据fixture）
// 见 mcp-deferred-ab.mjs 头注释。
// ============================================================
// ---------- 工具面（真实 MCP server 的写法画像；一行摘要 + 详情行） ----------
export const TOOL_SURFACES = [
  {
    serverName: "issue-tracker",
    tools: [
      {
        name: "search_issues",
        description:
          "Search issues by free-text keywords across projects.\nMatches issue title and body. Use list_issues when you have a project and structured filters instead.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            project_id: { type: "string" },
            state: { type: "string", enum: ["open", "closed"] },
            limit: { type: "integer" },
          },
          required: ["query"],
        },
      },
      {
        name: "list_issues",
        description:
          "List issues of one project with optional filters.\nRequires project_id; filters: state, assignee, label. Use search_issues for keyword queries across projects.",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            assignee: { type: "string" },
            state: { type: "string", enum: ["open", "closed"] },
            limit: { type: "integer" },
          },
          required: ["project_id"],
        },
      },
      {
        name: "get_issue",
        description:
          "Get one issue's details (title, body, state).\nFor its comment thread use list_comments; for its field-change history use list_issue_events.",
        inputSchema: {
          type: "object",
          properties: { issue_id: { type: "string" } },
          required: ["issue_id"],
        },
      },
      {
        name: "create_issue",
        description: "Create a new issue in a project.\nRequires project_id and title.",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
          },
          required: ["project_id", "title"],
        },
      },
      {
        name: "update_issue",
        description:
          "Update fields of one existing issue (state, title, assignee).\nTo leave remarks on an issue use add_comment instead.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            state: { type: "string", enum: ["open", "closed"] },
            title: { type: "string" },
            assignee: { type: "string" },
          },
          required: ["issue_id"],
        },
      },
      {
        name: "add_comment",
        description: "Add a comment to one issue's discussion thread.\nTo read the thread use list_comments.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            body: { type: "string" },
          },
          required: ["issue_id", "body"],
        },
      },
      {
        name: "list_comments",
        description:
          "List the comment thread of one issue.\nDiscussion only; for field changes (who changed what) use list_issue_events.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            limit: { type: "integer" },
          },
          required: ["issue_id"],
        },
      },
      {
        name: "list_issue_events",
        description:
          "List the field-change history (audit log) of one issue.\nEvents only; for the discussion use list_comments.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "string" },
            since: { type: "string" },
          },
          required: ["issue_id"],
        },
      },
      {
        name: "search_projects",
        description: "Search projects by keyword.\nMatches project name and description. To enumerate all projects use list_projects.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
          },
          required: ["query"],
        },
      },
      {
        name: "list_projects",
        description: "List projects, optionally filtered by organization.\nFor keyword search use search_projects.",
        inputSchema: {
          type: "object",
          properties: {
            org_id: { type: "string" },
            limit: { type: "integer" },
          },
          required: [],
        },
      },
      {
        name: "get_project",
        description: "Get one project's details (name, description, issue counts).\nFor its issues use list_issues.",
        inputSchema: {
          type: "object",
          properties: { project_id: { type: "string" } },
          required: ["project_id"],
        },
      },
      {
        name: "archive_project",
        description: "Archive a project, making it read-only.\nDestructive and hard to reverse; only when the user explicitly wants to retire a project.",
        inputSchema: {
          type: "object",
          properties: { project_id: { type: "string" } },
          required: ["project_id"],
        },
      },
    ],
  },
  {
    serverName: "data-platform",
    tools: [
      {
        name: "query_data",
        description: "Query data.",
        inputSchema: {
          type: "object",
          properties: {
            dataset: { type: "string" },
            sql: { type: "string" },
            limit: { type: "integer" },
          },
          required: ["dataset", "sql"],
        },
      },
      {
        name: "run_query_job",
        description: "Run a query job.",
        inputSchema: {
          type: "object",
          properties: {
            dataset: { type: "string" },
            sql: { type: "string" },
            priority: { type: "string", enum: ["low", "normal", "high"] },
          },
          required: ["dataset", "sql", "priority"],
        },
      },
      {
        name: "get_dataset",
        description: "Get dataset info.",
        inputSchema: {
          type: "object",
          properties: { dataset: { type: "string" } },
          required: ["dataset"],
        },
      },
      {
        name: "list_datasets",
        description: "List datasets.",
        inputSchema: {
          type: "object",
          properties: { workspace: { type: "string" } },
          required: [],
        },
      },
      {
        name: "export_table",
        description: "Export data.",
        inputSchema: {
          type: "object",
          properties: {
            dataset: { type: "string" },
            table: { type: "string" },
            format: { type: "string", enum: ["csv", "parquet"] },
          },
          required: ["dataset", "table", "format"],
        },
      },
      {
        name: "import_file",
        description: "Import data.",
        inputSchema: {
          type: "object",
          properties: {
            dataset: { type: "string" },
            file_url: { type: "string" },
            format: { type: "string", enum: ["csv", "parquet"] },
          },
          required: ["dataset", "file_url", "format"],
        },
      },
    ],
  },
];

// ---------- 任务集（每题一个标准答案工具；含近邻易混题） ----------
export const TASKS = [
  // issue-tracker（12）
  { surface: "issue-tracker", prompt: "ISSUE-4421 这个问题单的正文和当前状态是什么？", expected: "get_issue" },
  { surface: "issue-tracker", prompt: "帮我全文搜一下跟“支付超时”相关的问题单。", expected: "search_issues" },
  { surface: "issue-tracker", prompt: "把 proj-settle-02（结算中心）项目里分配给我、还没关的问题单列出来。", expected: "list_issues" },
  { surface: "issue-tracker", prompt: "建个新问题单：首页 LCP 超过 4 秒，放到 proj-perf-01（性能优化）项目下。", expected: "create_issue" },
  { surface: "issue-tracker", prompt: "把 ISSUE-4421 的状态改成已完成。", expected: "update_issue" },
  { surface: "issue-tracker", prompt: "在 ISSUE-4421 下面留言：修复已发到预发环境。", expected: "add_comment" },
  { surface: "issue-tracker", prompt: "ISSUE-4421 里大家都讨论了什么？把评论给我看。", expected: "list_comments" },
  { surface: "issue-tracker", prompt: "ISSUE-4421 这单子之前都被谁改过哪些字段？我要看变更记录。", expected: "list_issue_events" },
  { surface: "issue-tracker", prompt: "找一下名字里带“电商”的项目。", expected: "search_projects" },
  { surface: "issue-tracker", prompt: "把组织下的项目都列出来。", expected: "list_projects" },
  { surface: "issue-tracker", prompt: "看下 proj-settle-02（结算中心）这个项目的基本信息。", expected: "get_project" },
  { surface: "issue-tracker", prompt: "旧的 proj-mkt-07（营销站点）项目已经不用了，归档掉。", expected: "archive_project" },
  // data-platform（6）
  { surface: "data-platform", prompt: "跑个即席查询：sales 数据集（表 orders，时间列 created_at）昨天的订单数量是多少？", expected: "query_data" },
  { surface: "data-platform", prompt: "起一个后台查询任务，跑 sales 的月度聚合，优先级高。", expected: "run_query_job" },
  { surface: "data-platform", prompt: "orders 这个数据集的结构是什么样的？", expected: "get_dataset" },
  { surface: "data-platform", prompt: "把工作区里能用的数据集都列给我。", expected: "list_datasets" },
  { surface: "data-platform", prompt: "把 sales 数据集里的 orders 表导出成 parquet 文件。", expected: "export_table" },
  { surface: "data-platform", prompt: "把 /tmp/new-users.csv 导入 users 数据集。", expected: "import_file" },
];
