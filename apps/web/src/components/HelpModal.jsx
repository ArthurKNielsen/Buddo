import { Keyboard } from 'lucide-react';
import { SLASH_COMMANDS } from '@buddo/core';
import { useStore } from '../lib/store.js';
import Modal from './Modal.jsx';

const KEYS = [
  ['⌘ / Ctrl + K', 'Command palette'],
  ['⌘ / Ctrl + B', 'Toggle sidebar'],
  ['⌘ / Ctrl + J', 'Toggle side panel'],
  ['⌘ / Ctrl + ⇧ + O', 'New chat'],
  ['⌘ / Ctrl + ,', 'Settings'],
  ['⇧ + Tab', 'Cycle permission mode'],
  ['Enter / Esc', 'Allow / deny a pending action'],
  ['Esc', 'Stop Buddo'],
  ['↑', 'Edit last message (empty input)'],
  ['@', 'Mention a file'],
  ['/', 'Slash commands'],
];

export default function HelpModal() {
  const open = useStore((s) => s.ui.help);
  const { setUI } = useStore.getState();
  return (
    <Modal open={open} onClose={() => setUI({ help: false })} title="Commands & shortcuts" icon={<Keyboard size={17} />} width={720}>
      <div className="modal-body help-grid">
        <div>
          <h4>Slash commands</h4>
          {SLASH_COMMANDS.map((c) => (
            <div key={c.name} className="help-row">
              <code>/{c.name}</code>
              <span className="muted">{c.desc}</span>
            </div>
          ))}
        </div>
        <div>
          <h4>Keyboard</h4>
          {KEYS.map(([k, d]) => (
            <div key={k} className="help-row">
              <kbd>{k}</kbd>
              <span className="muted">{d}</span>
            </div>
          ))}
          <h4 style={{ marginTop: 18 }}>Modes</h4>
          <div className="help-row"><b>Ask</b><span className="muted">approve every edit & command</span></div>
          <div className="help-row"><b>Auto</b><span className="muted">edits auto-applied, commands need approval</span></div>
          <div className="help-row"><b>YOLO</b><span className="muted">everything auto-approved</span></div>
          <div className="help-row"><b>Plan</b><span className="muted">read-only investigation + plan</span></div>
        </div>
      </div>
    </Modal>
  );
}
