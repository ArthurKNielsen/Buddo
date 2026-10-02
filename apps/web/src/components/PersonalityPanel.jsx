import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, Trash2, Plus, X } from 'lucide-react';
import { VIBES } from '@buddo/core';
import { useStore } from '../lib/store.js';

const LEVELS = ['', 'Just starting out', 'Learning (some projects)', 'Comfortable', 'Professional developer'];

export default function PersonalityPanel() {
  const profile = useStore((s) => s.profile);
  const { setProfile, remember, forget, toast } = useStore.getState();
  const [draft, setDraft] = useState('');
  const n = profile.memories.length;

  return (
    <>
      <div className="knows">
        <Brain size={22} className="grad-text" style={{ color: 'var(--accent)' }} />
        <div>
          <b>{n}</b> <span className="muted">thing{n === 1 ? '' : 's'} {profile.name} knows about you</span>
          <div className="faint" style={{ fontSize: 12 }}>
            {profile.learn ? 'It learns as you chat — you can see and delete everything below.' : 'Learning is off.'}
          </div>
        </div>
      </div>

      <div className="field">
        <label>Vibe</label>
        <div className="vibe-grid">
          {Object.entries(VIBES).map(([id, v]) => (
            <motion.button key={id} className={'vibe' + (profile.vibe === id ? ' on' : '')} onClick={() => setProfile({ vibe: id })} whileTap={{ scale: 0.97 }}>
              <b>
                {v.emoji} {v.label}
              </b>
              <span className="faint">{v.style.split(/[.—]/)[0]}</span>
            </motion.button>
          ))}
        </div>
      </div>

      <div className="row" style={{ gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: 1, minWidth: 160 }}>
          <label>Its name</label>
          <input className="input" value={profile.name} maxLength={24} onChange={(e) => setProfile({ name: e.target.value || 'Buddo' })} />
        </div>
        <div className="field">
          <label>Reply length</label>
          <div className="seg">
            {['short', 'balanced', 'detailed'].map((v) => (
              <button key={v} className={profile.verbosity === v ? 'on' : ''} onClick={() => setProfile({ verbosity: v })}>
                {profile.verbosity === v && <motion.div layoutId="verb-pill" className="seg-pill" />}
                {v}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Emoji</label>
          <div className="seg">
            {['none', 'some', 'lots'].map((v) => (
              <button key={v} className={profile.emoji === v ? 'on' : ''} onClick={() => setProfile({ emoji: v })}>
                {profile.emoji === v && <motion.div layoutId="emoji-pill" className="seg-pill" />}
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="field">
        <label>Custom instructions</label>
        <textarea className="input" rows={2} placeholder="e.g. Always use TypeScript. Explain like I'm 15. Roast my code a little." value={profile.custom} onChange={(e) => setProfile({ custom: e.target.value })} />
      </div>

      <div className="field">
        <label>About you</label>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="Your name" value={profile.about.name} onChange={(e) => setProfile({ about: { ...profile.about, name: e.target.value } })} />
          <select className="input" style={{ flex: 1, minWidth: 180 }} value={profile.about.level} onChange={(e) => setProfile({ about: { ...profile.about, level: e.target.value } })}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l || 'Coding experience…'}
              </option>
            ))}
          </select>
        </div>
        <textarea className="input" rows={2} placeholder="Anything else? What you're building, tools you like, goals…" value={profile.about.info} onChange={(e) => setProfile({ about: { ...profile.about, info: e.target.value } })} />
      </div>

      <div className="field">
        <div className="row">
          <label style={{ flex: 1 }}>Memory</label>
          <span className="faint" style={{ fontSize: 12 }}>Learn about me</span>
          <button className={'switch' + (profile.learn ? ' on' : '')} onClick={() => setProfile({ learn: !profile.learn })} />
        </div>
        <div className="memories">
          <AnimatePresence initial={false}>
            {[...profile.memories].reverse().map((m) => (
              <motion.div key={m.id} className="mem" layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, height: 0, padding: 0, margin: 0 }}>
                <span>{m.text}</span>
                <span className="src">{m.source === 'manual' ? 'you added' : m.source === 'auto' ? 'learned' : 'from chat'}</span>
                <button className="icon-btn sm" title="Forget" onClick={() => forget(m.id)}>
                  <X size={13} />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
          {!n && <div className="faint" style={{ fontSize: 12.5 }}>Nothing yet — just chat, or add something below.</div>}
        </div>
        <form
          className="row"
          style={{ marginTop: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim() && remember(draft, 'manual')) setDraft('');
          }}
        >
          <input className="input" placeholder="Teach it something about you…" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn btn-outline" disabled={!draft.trim()}>
            <Plus size={14} /> Add
          </button>
        </form>
        {n > 0 && (
          <button
            className="btn btn-ghost btn-sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => {
              if (confirm(`Make ${profile.name} forget everything it learned about you?`)) {
                setProfile({ memories: [] });
                toast('Memory cleared', 'success');
              }
            }}
          >
            <Trash2 size={13} /> Forget everything
          </button>
        )}
      </div>
    </>
  );
}
