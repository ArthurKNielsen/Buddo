// Buddo's personality + what it knows about the user. Shared by the web app, desktop app and CLI.

export const VIBES = {
  buddy: { label: 'Friendly buddy', emoji: '🤝', style: 'Warm, upbeat and encouraging — like a friendly senior dev pairing with them. Casual but clear.' },
  genz: { label: 'Gen Z', emoji: '🔥', style: 'Talk like a Gen Z friend: casual slang (lowkey, ngl, fr, bet, gng) and emojis where they fit — but keep the technical content accurate and easy to follow.' },
  pro: { label: 'Professional', emoji: '💼', style: 'Calm, precise and concise. No slang, minimal emoji. Focus on facts, trade-offs and clear next steps.' },
  hype: { label: 'Hype coach', emoji: '🚀', style: 'High energy and motivating. Celebrate wins, push them to ship, keep sentences short and punchy.' },
  teacher: { label: 'Patient teacher', emoji: '🎓', style: 'Explain the why behind each step in simple words, define jargon, and suggest what to learn next. Great for beginners.' },
  minimal: { label: 'Minimal', emoji: '⚡', style: 'Extremely brief. Do the work and report results in as few words as possible. No small talk, no emoji.' },
};

export const VERBOSITY = {
  short: 'Keep replies very short.',
  balanced: 'Keep replies focused and skimmable.',
  detailed: 'Give thorough, detailed explanations.',
};

export const EMOJI = { none: 'Never use emoji.', some: 'Use an emoji now and then.', lots: 'Use plenty of emoji.' };

export const DEFAULT_PROFILE = {
  name: 'Buddo',
  vibe: 'buddy',
  verbosity: 'balanced',
  emoji: 'some',
  custom: '',
  about: { name: '', level: '', info: '' },
  learn: true,
  memories: [], // [{ id, text, at, source: 'chat' | 'auto' | 'manual' }]
};

export function normalizeProfile(p = {}) {
  return { ...DEFAULT_PROFILE, ...p, about: { ...DEFAULT_PROFILE.about, ...(p.about || {}) }, memories: Array.isArray(p.memories) ? p.memories : [] };
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/** Add a memory unless it's (nearly) a duplicate. Returns the new profile or null if nothing changed. */
export function addMemory(profile, text, source = 'chat') {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!t) return null;
  const n = norm(t);
  if (profile.memories.some((m) => norm(m.text) === n || (n.length > 20 && (norm(m.text).includes(n) || n.includes(norm(m.text)))))) return null;
  const memory = { id: Math.random().toString(36).slice(2, 10), text: t, at: Date.now(), source };
  return { ...profile, memories: [...profile.memories, memory].slice(-200) };
}

/** The personality + user-knowledge section of the system prompt. */
export function personalityPrompt(profile, { lite = false } = {}) {
  const p = normalizeProfile(profile);
  const vibe = VIBES[p.vibe] || VIBES.buddy;
  const lines = [`# Personality\nYour name is ${p.name}. ${vibe.style} ${VERBOSITY[p.verbosity] || ''} ${EMOJI[p.emoji] || ''}`.trim()];
  if (p.custom.trim()) lines.push(`Extra instructions from the user: ${p.custom.trim()}`);
  const about = [p.about.name && `Name: ${p.about.name}`, p.about.level && `Experience: ${p.about.level}`, p.about.info && p.about.info.trim()].filter(Boolean);
  const mems = p.memories.slice(lite ? -10 : -40).map((m) => `- ${m.text}`);
  if (about.length || mems.length) {
    lines.push(`\n# About the user`);
    if (about.length) lines.push(about.join('\n'));
    if (mems.length) lines.push(`What you've learned about them:\n${mems.join('\n')}`);
    lines.push("Use this naturally to tailor your help (their name, level, favorite tools). Don't recite it unless they ask what you know about them.");
  }
  if (p.learn) lines.push('When you learn something lasting about the user (preferences, skills, projects, goals), save it with the remember tool — briefly, then continue.');
  return lines.join('\n');
}

export const LEARN_PROMPT = (known, userText) => `Here is what you already know about the user:
${known.length ? known.map((m) => `- ${m}`).join('\n') : '(nothing yet)'}

Here are their latest messages:
"""
${userText}
"""

List NEW lasting facts about the user worth remembering for future conversations (name, skills, experience level, preferred languages/tools/style, ongoing projects, goals). Skip anything temporary, already known, or sensitive (passwords, keys, addresses). Answer with one fact per line starting with "- ", or exactly NONE.`;

export function parseLearned(text) {
  if (/^\s*NONE\b/i.test(text)) return [];
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter((l) => l.length > 6 && l.length < 200 && !/^none$/i.test(l))
    // File names are about one project on one day, not the user: a remembered "has src/app.js" haunts every chat.
    .filter((l) => !/(^|[\s/"'`(])[\w.-]+\.(m?jsx?|tsx?|html?|css|s[ac]ss|py|json|md|vue|svelte|mp4|mov|mp3)\b/i.test(l))
    .slice(0, 5);
}
