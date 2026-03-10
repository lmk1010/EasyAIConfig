// ════════════════════════════════════════════════════════════════
// Config Store Guides — detailed setup instructions
// ════════════════════════════════════════════════════════════════

import { CODEX_SPECIAL_GUIDES } from './config-store-guides-codex.js';
import { OPENCLAW_SPECIAL_GUIDES } from './config-store-guides-openclaw.js';

export const SPECIAL_GUIDES = {
  ...CODEX_SPECIAL_GUIDES,
  ...OPENCLAW_SPECIAL_GUIDES,
};
