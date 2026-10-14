// @ts-check
'use strict';

const { plainObject } = require('./fields');
const { claudeModelIsLocal, modelName } = require('./model');

const TOOL_STATUS = Object.freeze({
  Edit: 'Building', Write: 'Building', NotebookEdit: 'Building', MultiEdit: 'Building',
  Read: 'Exploring', Grep: 'Exploring', Glob: 'Exploring', LSP: 'Exploring',
  Bash: 'Gathering Resources', PowerShell: 'Gathering Resources', BashOutput: 'Gathering Resources',
  WebSearch: 'Scanning', WebFetch: 'Scanning',
  Agent: 'Delegating', Task: 'Delegating', Workflow: 'Delegating',
  TodoWrite: 'Planning', TaskCreate: 'Planning', EnterPlanMode: 'Planning', ExitPlanMode: 'Planning',
});
const BUILD_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

/**
 * @typedef {object} ClaudeSession Every record restates its session envelope.
 * @property {'session'} type
 * @property {string | null} cwd As written.
 * @property {'main' | 'drone'} kind 'drone' for a sidechain record.
 *
 * @typedef {object} ClaudeTurnEnd
 * @property {'turn-end'} type
 *
 * @typedef {object} ClaudeMessage The shape of the record's message; each model decides
 *   which shapes start a turn.
 * @property {'message'} type
 * @property {boolean} assistant The record or its message is the assistant's.
 * @property {boolean} user The record or its message is the user's.
 * @property {boolean} prompt The content is a plain string.
 * @property {boolean} blocks The content is an array of blocks.
 * @property {boolean} text A block is text.
 * @property {boolean} toolResult A block is a tool result.
 * @property {boolean | null} local An assistant message from a non-Claude (local) model; null
 *   when the message names no model.
 * @property {string | null} model The assistant message's model as written; null when absent.
 *
 * @typedef {object} ClaudeToolStart
 * @property {'tool-start'} type
 * @property {any} callId The tool_use id as written.
 * @property {any} tool The tool name as written.
 * @property {string | null} filePath input.file_path when it is a string.
 * @property {string | null} detail Without a file path: the pattern or description, cut to 60
 *   characters. Only the live view shows it.
 *
 * @typedef {object} ClaudeToolEnd
 * @property {'tool-end'} type
 * @property {any} callId The tool_use_id as written.
 *
 * @typedef {ClaudeSession | ClaudeTurnEnd | ClaudeMessage | ClaudeToolStart | ClaudeToolEnd} ClaudeSignal
 */

/**
 * The structural facts in one parsed Claude Code transcript record, in record order: the
 * session first, then a turn end, the message shape, and one signal per tool call or result.
 * Any JSON value is accepted; a non-object is an empty record.
 * @param {unknown} value
 * @returns {ClaudeSignal[]}
 */
function claudeRecordToSignals(value) {
  const record = plainObject(value) ? value : {};
  /** @type {ClaudeSignal[]} */
  const signals = [{
    type: 'session',
    cwd: typeof record.cwd === 'string' ? record.cwd : null,
    kind: record.isSidechain === true ? 'drone' : 'main',
  }];
  if (record.type === 'system' && record.subtype === 'turn_duration') signals.push({ type: 'turn-end' });

  const message = record.message;
  if (!message || typeof message !== 'object') return signals;
  const content = message.content;
  const blocks = Array.isArray(content) ? content.filter(plainObject) : [];
  const assistant = record.type === 'assistant' || message.role === 'assistant';
  signals.push({
    type: 'message',
    assistant,
    user: record.type === 'user' || message.role === 'user',
    prompt: typeof content === 'string',
    blocks: Array.isArray(content),
    text: blocks.some((block) => block.type === 'text'),
    toolResult: blocks.some((block) => block.type === 'tool_result'),
    local: assistant ? claudeModelIsLocal(message.model) : null,
    model: assistant ? modelName(message.model) : null,
  });
  for (const block of blocks) {
    if (block.type === 'tool_use') signals.push(toolStart(block));
    else if (block.type === 'tool_result') signals.push({ type: 'tool-end', callId: block.tool_use_id });
  }
  return signals;
}

/**
 * @param {Record<string, any>} block
 * @returns {ClaudeToolStart}
 */
function toolStart(block) {
  const input = block.input || {};
  const filePath = typeof input.file_path === 'string' ? input.file_path : null;
  let detail = null;
  if (filePath === null && typeof input.pattern === 'string') detail = input.pattern.slice(0, 60);
  else if (filePath === null && typeof input.description === 'string') detail = input.description.slice(0, 60);
  return { type: 'tool-start', callId: block.id, tool: block.name, filePath, detail };
}

/**
 * Claude Code's own reading of a tool name, which the live view keeps. History maps every
 * provider's tools through classifyTool instead.
 * @param {any} tool
 * @returns {{ status: string, build: boolean, spawn: boolean }}
 */
function claudeTool(tool) {
  return { status: TOOL_STATUS[tool] || 'Working', build: BUILD_TOOLS.has(tool), spawn: SPAWN_TOOLS.has(tool) };
}

module.exports = { claudeRecordToSignals, claudeTool };
