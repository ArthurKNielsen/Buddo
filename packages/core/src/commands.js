// Slash commands shared by the web app and the CLI.
// `prompt` commands expand into an agent request; `action` commands are handled by the UI.

export const SLASH_COMMANDS = [
  { name: 'help', desc: 'Show commands and shortcuts', action: 'help' },
  { name: 'clear', desc: 'Start a fresh conversation', action: 'clear' },
  { name: 'model', desc: 'Switch the local model', action: 'model' },
  { name: 'mode', desc: 'Change permission mode (ask / auto / yolo / plan)', action: 'mode', arg: 'mode' },
  { name: 'compact', desc: 'Summarize the conversation to free up context', action: 'compact' },
  {
    name: 'init',
    desc: 'Analyze the project and write BUDDO.md memory',
    prompt: () =>
      'Explore this codebase (structure, package/config files, entry points, scripts) and create a concise BUDDO.md at the project root. Include: a one-paragraph overview, tech stack, how to install/run/build/test (exact commands), key directories and what lives there, and code conventions you observed. Keep it under 80 lines. If BUDDO.md already exists, improve it instead.',
  },
  {
    name: 'review',
    desc: 'Review current changes for bugs',
    arg: 'focus',
    prompt: (a) =>
      `Review the current uncommitted changes in this project (use \`git diff\` and \`git status\` if commands are available, otherwise inspect recently relevant files). Look for bugs, edge cases, security issues and unclear code. ${a ? `Focus on: ${a}. ` : ''}Report findings ranked by severity with file:line references and concrete fixes. Do not edit files.`,
  },
  {
    name: 'explain',
    desc: 'Explain a file, function or the whole project',
    arg: 'target',
    prompt: (a) => `Explain ${a || 'this project'}: what it does, how it is structured, and how the important pieces fit together. Read the relevant code first. Be clear and concrete.`,
  },
  {
    name: 'fix',
    desc: 'Find and fix a bug',
    arg: 'issue',
    prompt: (a) => `Fix this problem: ${a || 'look for the most likely bug in the project'}. Reproduce or locate it first, make the minimal correct fix, then verify it.`,
  },
  {
    name: 'test',
    desc: 'Run tests and fix failures',
    arg: 'target',
    prompt: (a) => `Find how this project runs its tests and run them${a ? ` (focus: ${a})` : ''}. If anything fails, diagnose the root cause and fix it, then re-run until green. If there are no tests, propose and add a sensible minimal test setup.`,
  },
  {
    name: 'commit',
    desc: 'Write a commit for current changes',
    prompt: () => 'Inspect `git status` and `git diff`, then stage the relevant changes and create a git commit with a clear conventional commit message (subject ≤ 72 chars + short body). Do not push.',
  },
  {
    name: 'plan',
    desc: 'Plan a task without changing anything',
    arg: 'task',
    mode: 'plan',
    prompt: (a) => `Create a detailed implementation plan for: ${a}. Investigate the relevant code first.`,
  },
  {
    name: 'refactor',
    desc: 'Refactor code for clarity',
    arg: 'target',
    prompt: (a) => `Refactor ${a || 'the most tangled part of this codebase'} for readability and maintainability without changing behavior. Verify nothing breaks.`,
  },
  {
    name: 'docs',
    desc: 'Write or improve documentation',
    arg: 'target',
    prompt: (a) => `Write or improve documentation for ${a || 'this project (README)'}: purpose, setup, usage examples. Keep it accurate to the code.`,
  },
  {
    name: 'watch',
    desc: 'Watch a video, listen to audio or look at an image',
    arg: 'file',
    prompt: (a) => `Perceive ${a || 'the media files in this project'} with your media tools (watch_video / listen_audio / view_image) and describe what you see and hear, with timestamps for video/audio.`,
  },
  {
    name: 'scaffold',
    desc: 'Create a new project or feature from scratch',
    arg: 'description',
    prompt: (a) => `Build this from scratch in the workspace: ${a}. Plan with the todo tool, create all files with clean, modern code, and verify it runs if commands are available.`,
  },
];

export function parseSlash(input) {
  const m = /^\/([a-z-]+)\s*([\s\S]*)$/i.exec(input.trim());
  if (!m) return null;
  const cmd = SLASH_COMMANDS.find((c) => c.name === m[1].toLowerCase());
  return cmd ? { cmd, arg: m[2].trim() } : { unknown: m[1] };
}

export const COMPACT_PROMPT =
  'Summarize our conversation so far for your own future reference: the user goals, key decisions, files touched (with paths), current state, and remaining TODOs. Be dense and factual; no tool calls.';
