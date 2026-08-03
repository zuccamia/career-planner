// Renders the "AI provider" pill in the sidebar. Three states:
//   - BYOK active                      → slate  "BYOK · <model>"
//   - BYOK off, server-side LLM set    → slate  "Server · <model>"
//   - BYOK off, no server-side LLM     → amber  "AI: setup needed"
// The active states are neutral config facts, not success — reserve
// green for actual success states.
// BYOK takes precedence — a user who configured their own key sees the BYOK
// badge even when the deploy also has a server-side LLM. Clicking navigates
// to Settings → AI provider.

import { getByokConfig } from '../storage/byok.mjs';
import { getServerLLMStatus } from '../llm-client.mjs';
import { badge } from './components.mjs';

export const refreshAiModeBadge = async () => {
  const wrap = document.getElementById('ai-mode-badge');
  if (!wrap) return;

  try {
    const [cfg, serverLLM] = await Promise.all([getByokConfig(), getServerLLMStatus()]);
    const byokActive = !!(cfg && cfg.enabled && cfg.baseUrl && cfg.apiKey && cfg.model);
    if (byokActive) {
      wrap.innerHTML = badge({ color: 'slate', size: 'xs', icon: 'sparkles', label: `BYOK · ${cfg.model}` });
    } else if (serverLLM.available) {
      wrap.innerHTML = badge({ color: 'slate', size: 'xs', icon: 'sparkles', label: `Server · ${serverLLM.model}` });
    } else {
      wrap.innerHTML = badge({ color: 'amber', size: 'xs', icon: 'sparkles', label: 'AI: setup needed' });
    }
    wrap.classList.remove('hidden');
  } catch (err) {
    console.warn('[local] ai mode badge', err);
    wrap.classList.add('hidden');
  }
};
