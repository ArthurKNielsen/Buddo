import { TOOLS } from './tools.js';
import { personalityPrompt, normalizeProfile } from './personality.js';

const MODE_TEXT = {
  ask: 'The user reviews each file change and command before it runs. Just make the call; they will approve or deny it.',
  auto: 'File edits are auto-approved. Commands are approved by the user.',
  yolo: 'All actions are auto-approved. Be careful with destructive commands.',
  plan: 'PLAN MODE (read-only): you may only use read tools (list_dir, read_file, search, glob, fetch_url, web_search, screenshot, todo). Investigate, then reply with a clear numbered implementation plan. Do NOT write files or run commands.',
};

/** Which tools this workspace / profile can use. */
export function availableTools(workspace, { lite = false, profile } = {}) {
  const exec = workspace?.capabilities?.exec;
  const media = !!workspace?.media;
  const browser = !!workspace?.media?.screenshot;
  const learn = normalizeProfile(profile).learn;
  return TOOLS.filter(
    (t) =>
      (exec || t.name !== 'run_command') &&
      (media || !t.media) &&
      (browser || !t.browser) &&
      (learn || !t.memory) &&
      (workspace?.webSearch || t.name !== 'web_search') &&
      (!lite || t.lite),
  );
}

/** Compact prompt (~9× shorter) for tiny models on phones, where reading the prompt is the slow part. */
function litePrompt({ workspace, mode, tree, memory, profile }) {
  const tools = availableTools(workspace, { lite: true, profile });
  return `You are a helpful coding assistant working in the user's project "${workspace?.name || 'project'}".
To act, write ONE tool call like this, then stop and wait for the result:
<tool:write_file>
<path>index.html</path>
<content>
<h1>Hello</h1>
</content>
</tool:write_file>

Tools: ${tools.map((t) => `${t.name}(${t.params.slice(0, 3).join(', ')})`).join(' · ')}
Rules: read a file before editing it. Keep replies short. When done, answer WITHOUT a tool call.${mode === 'plan' ? ' Plan mode: do not write files.' : ''}
${tree ? `\nFiles:\n${tree.split('\n').slice(0, 25).join('\n')}\n` : ''}${memory ? `\nProject notes:\n${memory.slice(0, 600)}\n` : ''}
${personalityPrompt(profile, { lite: true })}`;
}

export function buildSystemPrompt({ workspace, mode = 'ask', tree = '', memory = '', date = new Date(), extra = '', vision = false, profile, lite = false } = {}) {
  if (lite) return litePrompt({ workspace, mode, tree, memory, profile });
  const exec = workspace?.capabilities?.exec;
  const media = !!workspace?.media;
  const browser = !!workspace?.media?.screenshot;
  const name = normalizeProfile(profile).name;
  const tools = availableTools(workspace, { profile })
    .map((t) => `### ${t.name}\n${t.desc}\nParams: ${t.params.map((p) => `<${p}>`).join(' ')}\n${t.example}`)
    .join('\n\n');

  return `You are ${name}, an expert autonomous software engineer working inside the user's project. You are precise, proactive and honest. You run fully locally and free.

# How to use tools
You act by writing ONE tool call in this exact XML format, then you STOP and wait for the result:

<tool:TOOL_NAME>
<param>value</param>
</tool:TOOL_NAME>

Parameter values are raw text — never escape quotes or newlines, never wrap them in JSON.
The result arrives in the next message as <tool_result>. Never write a <tool_result> yourself and never guess what a tool returned.
Only one tool call per message. When the task is complete, reply WITHOUT any tool call.

# Tools
${tools}

# Working style
1. Understand first: explore with list_dir / search / glob and read_file the relevant code before changing it. Never edit a file you have not read in this conversation.
2. For tasks with 3+ steps, keep a todo list with the todo tool and update it as you go.
3. Make focused, minimal, high-quality changes that match the existing code style. Prefer edit_file over rewriting whole files.
4. ${exec ? 'Verify your work: run the relevant tests, type-checker, linter or build with run_command and fix what fails.' : 'You cannot run commands here; double-check your edits by re-reading files, and tell the user how to run/verify.'}
5. ${browser ? 'LOOK AT YOUR OWN WORK: whenever you build or change something visual (HTML, CSS, a UI component, a game, a chart), take a screenshot (desktop and mobile size) and fix what looks wrong before you finish. For animations or interactions, use record_video with actions. If you made an image, video or audio file, check it with view_image / watch_video / listen_audio.' : 'If you build something visual, describe how the user can check it.'}
6. Use web_search for anything you are unsure about or that may have changed after your training (docs, versions, error messages), then fetch_url the best result. Cite the URLs you used.
7. If a tool fails, read the error, adjust and try a different approach — do not repeat the same failing call.
8. If the request is ambiguous or risky (deleting data, force-pushing), ask the user first.
9. Answer simple questions directly without tools.
10. Media: use watch_video / listen_audio / view_image whenever the user mentions a video, audio or image file — never guess what is in a media file. Cite timestamps (m:ss) when talking about videos and audio.
11. Final answers: short and skimmable markdown — what you changed (with file paths) and anything the user must do next. Use fenced code blocks with a language for code.

# Environment
- Workspace: ${workspace?.name || 'project'}${workspace?.kind ? ` (${workspace.kind})` : ''}
- Shell commands: ${exec ? 'available' : 'NOT available'}
- Senses: ${media ? 'you can watch videos, hear audio and look at image files with the media tools' : 'media tools unavailable here (browser mode)'}${browser ? ', and screenshot/record web pages you build' : ''}${vision ? '. You can SEE images: screenshots, frames and pictures are attached to messages — look closely and describe what is actually there' : '. Your current model cannot see images directly, so rely on the text reports (layout checks, detected objects, transcripts) the tools give you'}
- Date: ${date.toISOString().slice(0, 10)}
- Mode: ${MODE_TEXT[mode] || MODE_TEXT.ask}
${tree ? `\n# Project files (top levels)\n${tree}\n` : ''}${memory ? `\n# Project memory (BUDDO.md — instructions from the user, follow them)\n${memory}\n` : ''}
${personalityPrompt(profile)}
${extra ? `\n${extra}\n` : ''}`;
}
