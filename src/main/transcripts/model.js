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
 * The model a record names, as the chrome may print it: no control or format characters, at
 * most MODEL_NAME_LIMIT characters; null when absent.
 * @param {unknown} value
 * @returns {string | null}
 */
function modelName(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/\p{C}/gu, '').trim().slice(0, MODEL_NAME_LIMIT) || null;
}

/**
 * What a Claude Code assistant message says about its model: the name, and whether it is a
 * model other than Claude, which only a local endpoint serves. Both null when the message
 * names no model, including Claude Code's own '<synthetic>' messages.
 * @param {unknown} value
 * @returns {{ local: boolean | null, model: string | null }}
 */
function claudeModel(value) {
  const model = modelName(value);
  if (model === null || model === '<synthetic>') return { local: null, model: null };
  return { local: !/claude/i.test(model), model };
}

module.exports = { codexProviderIsLocal, claudeModel, modelName };
