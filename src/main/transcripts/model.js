// @ts-check
'use strict';

// Codex model providers that serve a model from this machine. Anything else (openai,
// azure, a hosted gateway) is a remote model.
const LOCAL_CODEX_PROVIDERS = new Set([
  'oss', 'ollama', 'lmstudio', 'lm-studio', 'llamacpp', 'llama.cpp', 'llama-cpp', 'vllm', 'localai', 'local',
]);
const MODEL_NAME_LIMIT = 64;

/**
 * Whether a Codex rollout's `model_provider` runs locally; null when the rollout does not say.
 * @param {unknown} provider
 * @returns {boolean | null}
 */
function codexProviderIsLocal(provider) {
  if (typeof provider !== 'string' || !provider.trim()) return null;
  return LOCAL_CODEX_PROVIDERS.has(provider.trim().toLowerCase());
}

/**
 * Whether a Claude Code assistant message came from a model other than Claude, which only a
 * local endpoint serves; null when the record names no model (or Claude Code's '<synthetic>').
 * @param {unknown} model
 * @returns {boolean | null}
 */
function claudeModelIsLocal(model) {
  if (typeof model !== 'string' || !model.trim() || model === '<synthetic>') return null;
  return !/claude/i.test(model);
}

/**
 * The model a record names, as the chrome may print it: printable ASCII, at most
 * MODEL_NAME_LIMIT characters; null when absent or Claude Code's '<synthetic>'.
 * @param {unknown} value
 * @returns {string | null}
 */
function modelName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[^\x20-\x7e]/g, '').trim().slice(0, MODEL_NAME_LIMIT);
  return name && name !== '<synthetic>' ? name : null;
}

module.exports = { codexProviderIsLocal, claudeModelIsLocal, modelName };
