// Personality + memories live in ~/.buddo/profile.json so the desktop app, web app and CLI share one Buddo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeProfile, addMemory } from './personality.js';

export const PROFILE_FILE = () => process.env.BUDDO_PROFILE || path.join(os.homedir(), '.buddo', 'profile.json');

export function loadProfile() {
  try {
    return normalizeProfile(JSON.parse(fs.readFileSync(PROFILE_FILE(), 'utf8')));
  } catch {
    return normalizeProfile({});
  }
}

export function saveProfile(p) {
  const file = PROFILE_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalizeProfile(p), null, 2));
  fs.renameSync(tmp, file);
}

/** Append a memory to the saved profile. Returns false if it was already known. */
export function rememberFact(text, source = 'chat') {
  const next = addMemory(loadProfile(), text, source);
  if (!next) return false;
  saveProfile(next);
  return true;
}
