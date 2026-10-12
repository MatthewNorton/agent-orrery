// @ts-check
'use strict';

// Codex model providers that serve a model from this machine. Anything else (openai,
// azure, a hosted gateway) is a remote model.
const LOCAL_CODEX_PROVIDERS = new Set([
  'oss', 'ollama', 'lmstudio', 'lm-studio', 'llamacpp', 'llama.cpp', 'llama-cpp', 'vllm', 'localai', 'local',
]);

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

module.exports = { codexProviderIsLocal, claudeModelIsLocal };
