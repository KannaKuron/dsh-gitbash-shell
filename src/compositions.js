/**
 * dsh-gitbash-shell — declarative composition rows (dsh >= 0.1.7).
 *
 * dsh 0.1.7 removed directory presets; a preset is a definition registered
 * through agentPresets.register(). This module is the committed, reviewable
 * composition DATA for the four Git Bash variants — the new-era counterpart
 * of the committed assets/<variant>/agent.cordis*.yml texts the materializer
 * writes on older hosts.
 *
 * Every variant mirrors the official 0.1.7 preset it replaces (packages/
 * bundle/web-app/presets/{standard,minimal,ptc,cordis}.patch.yml) with the
 * one Git Bash delta: the bash rows are always on and the pwsh rows are
 * always off (the host executor is this plugin's shell.js — on non-Windows
 * hosts that is the native stack anyway, which is exactly what the old
 * materialized variants encoded).
 */

/** Default Git Bash binary — must match src/shell.js and the patch config. */
const DEFAULT_GIT_BASH = 'C:/Program Files/Git/bin/bash.exe'

function off(value) {
  return value === true ? { disabled: true } : {}
}

const PLAN_SECTION = `You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.
`

/**
 * The shared full-tool rows for standard / ptc / cordis variants (pure).
 * @param {object} input
 * @param {'standard'|'ptc'|'cordis'} input.kind - which official preset this
 *   variant mirrors (workflow rows follow it: enabled on standard/cordis,
 *   disabled on ptc).
 * @param {boolean} input.gitBash - bash rows always on, pwsh rows always off.
 * @param {string|undefined} input.skillsDir - Creation authoring skills
 *   directory (cordis variant only; resolved beside the agent-preset package).
 * @returns {object[]} the declarative plugins list.
 */
export function pluginsFor({ kind, gitBash, skillsDir }) {
  const win = typeof process !== 'undefined' && process.platform === 'win32'
  const bashDisabled = gitBash ? false : win
  const pwshDisabled = gitBash ? true : !win
  const workflowOn = kind !== 'ptc'
  const rows = [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        prefix: 'You are a coding agent powered by the {{model}} model.',
        suffix: 'Your working directory is {{cwd}}.',
      },
    },
    {
      id: 'agent-instructions',
      name: '@deepseek-ai/dsh-agent-instructions',
      config: { maxBytes: 65536 },
    },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', ...off(bashDisabled) },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', ...off(pwshDisabled) },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    {
      id: 'tool-fs-search',
      name: '@deepseek-ai/dsh-tool-fs-search',
      config: { sampleOverCapGlobResults: false },
    },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    ...((kind === 'standard' || kind === 'ptc') ? [
      { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
      { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    ] : []),
    { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
    {
      id: 'planning',
      name: 'cordis:group',
      group: true,
      isolate: { planMode: true },
      config: [
        {
          id: 'plan-mode',
          name: '@deepseek-ai/dsh-plan-mode',
          config: { section: PLAN_SECTION },
        },
      ],
    },
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
        },
      ],
    },
    {
      id: 'delegation',
      name: 'cordis:group',
      group: true,
      isolate: { workflowEngine: true },
      config: [
        { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
        { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
        {
          id: 'tool-subagent',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true, backgroundMode: 'continuable' },
        },
        {
          id: 'tool-subagent-fork',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: { provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable' },
        },
        {
          id: 'tool-subagent-codex',
          name: '@deepseek-ai/dsh-tool-subagent',
          disabled: true,
          config: { provider: 'codex', toolName: 'subagent_codex', backgroundMode: 'one-shot', maxDepth: 'provider-managed' },
        },
        {
          id: 'tool-subagent-claude-code',
          name: '@deepseek-ai/dsh-tool-subagent',
          disabled: true,
          config: { provider: 'claude-code', toolName: 'subagent_claude_code', backgroundMode: 'one-shot', maxDepth: 'provider-managed' },
        },
        {
          id: 'workflow-ptc',
          name: '@deepseek-ai/dsh-workflow-ptc',
          ...off(!workflowOn),
          config: { provider: 'spawn' },
        },
        { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow', ...off(!workflowOn) },
        {
          id: 'tool-ralph',
          name: '@deepseek-ai/dsh-tool-ralph',
          disabled: true,
          config: { subagentProvider: 'spawn', maxRounds: 64 },
        },
      ],
    },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    {
      id: 'tool-todo',
      name: '@deepseek-ai/dsh-tool-todo',
      config: { allowParallelInProgress: true },
    },
    {
      id: 'tool-web',
      name: '@deepseek-ai/dsh-tool-web',
      config: { fetch: true, searchTimeoutMs: 60000 },
    },
  ]
  if (kind === 'ptc') {
    rows.push({
      id: 'tool-presentation',
      name: '@deepseek-ai/dsh-agent-tool-presentation',
      config: { mode: 'ptc' },
    })
  }
  if (kind === 'cordis') {
    rows.push({ id: 'tool-cordis', name: '@deepseek-ai/dsh-tool-cordis' })
  }
  if (kind === 'cordis') {
    rows.push({ id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', ...(skillsDir ? { config: { customSkillDirs: [skillsDir] } } : {}) })
    rows.push({ id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' })
  }
  rows.push({ id: 'present', name: '@deepseek-ai/dsh-tool-present' })
  rows.push({
    id: 'tool-plugin-manager',
    name: '@deepseek-ai/dsh-plugin-manager/tools',
    // The official 0.1.7 rows: ptc/standard ship it disabled, cordis keeps it
    // on wherever a profile context exists (every web deployment does).
    ...off(kind !== 'cordis'),
  })
  return rows
}

/**
 * The minimal variant: the official single-tool preset with the Git Bash
 * delta — bash rows always on (the terminal row pins the Git Bash binary on
 * Windows), pwsh rows always off (pure).
 * @returns {object[]} the declarative plugins list.
 */
export function minimalPluginsFor() {
  const win = typeof process !== 'undefined' && process.platform === 'win32'
  return [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        prefix: 'You are a helpful software engineer assistant.',
        complete: true,
        includeRuntimeContext: false,
      },
    },
    {
      id: 'persistent-shell',
      name: 'cordis:group',
      group: true,
      isolate: { terminals: true },
      config: [
        { id: 'pty', name: '@deepseek-ai/dsh-terminal' },
        {
          id: 'terminal-bash',
          name: '@deepseek-ai/dsh-terminal-bash',
          disabled: false,
          config: {
            timeoutMs: 300000,
            shellPath: win ? DEFAULT_GIT_BASH : '/bin/bash',
          },
        },
        {
          id: 'persistent-bash',
          name: '@deepseek-ai/dsh-tool-bash-persistent',
          disabled: false,
          config: {
            timeoutMs: 300000,
            description: [
              'Run commands in a bash shell (Git for Windows bash on Windows: native paths like C:/... work, and PATH plus the rest of the environment are inherited from the host)',
              '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
              '* Network access depends on the task environment. Prefer configured mirrors/proxies when they are available.',
              '* State is persistent across command calls and discussions with the user.',
              '* To inspect a particular line range of a file, e.g. lines 10-25, try \'sed -n 10,25p /path/to/the/file\'.',
              '* Please avoid commands that may produce a very large amount of output.',
              '* Please run long lived commands in the background, e.g. \'sleep 10 &\' or start a server in the background.',
            ].join('\n'),
          },
        },
        {
          id: 'terminal-pwsh',
          name: '@deepseek-ai/dsh-terminal-bash',
          disabled: true,
          config: { shellDialect: 'pwsh', timeoutMs: 300000 },
        },
        {
          id: 'persistent-pwsh',
          name: '@deepseek-ai/dsh-tool-pwsh-persistent',
          disabled: true,
          config: {
            timeoutMs: 300000,
            description: [
              "Run commands in a PowerShell shell",
              "* When invoking this tool, the contents of the \"command\" parameter does NOT need to be XML-escaped.",
              "* You don't have access to the internet via this tool.",
              "* State is persistent across command calls and discussions with the user.",
              "* Use native Windows paths (C:\\...) and $env:NAME variables; this is PowerShell, not bash.",
              "* Please avoid commands that may produce a very large amount of output.",
              "* Please run long lived commands in the background, e.g. 'Start-Job' or start a server with Start-Process.",
            ].join('\n') + '\n',
          },
        },
      ],
    },
  ]
}

/** Display metadata for the four registrations (mirrors the committed preset.yml files). */
export const PRESET_META = {
  'standard-gitbash': {
    kind: 'standard',
    name: '标准模式 · Git Bash',
    description: '功能完整的编码 Agent,支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。(Shell 使用 Git Bash)',
    order: 1,
  },
  'code-gitbash': {
    kind: 'ptc',
    name: 'PTC 模式 · Git Bash',
    description: '功能完整的编码 Agent,但默认不提供 workflow 工具;其他工具通过 PTC 模式 SDK 呈现,让模型用一个 TypeScript 程序组合多步操作。(Shell 使用 Git Bash)',
    order: 2,
  },
  'minimal-gitbash': {
    kind: 'minimal',
    name: '极简模式 · Git Bash',
    description: '仅提供持久 shell 的单工具编码 Agent。(Shell 使用 Git Bash)',
    order: 3,
  },
  'cordis-gitbash': {
    kind: 'cordis',
    name: '创造模式 · Git Bash',
    description: '用于创建自定义 Agent preset:具备标准模式的全部能力,并提供运行时检查、插件实验和 preset 创作指导。(Shell 使用 Git Bash)',
    order: 4,
  },
}
