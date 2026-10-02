import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Folder, FolderOpen, ArrowUp, Home, FolderPlus, HardDrive, Box, Globe, Check, Sparkles } from 'lucide-react';
import { useStore } from '../lib/store.js';
import { api, supportsFolderAccess } from '../lib/workspaces.js';
import { openServerFolder, pickBrowserFolder, useSandbox, reconnectFolder } from '../lib/engine.js';
import Modal from './Modal.jsx';

function ServerBrowser({ onDone }) {
  const ws = useStore((s) => s.ws);
  const [dir, setDir] = useState(null);
  const [err, setErr] = useState('');
  const [path, setPath] = useState('');

  const load = async (p) => {
    try {
      setErr('');
      const d = await api(`/api/dirs?path=${encodeURIComponent(p || '')}`);
      setDir(d);
      setPath(d.path);
    } catch (e) {
      setErr(e.message);
    }
  };
  useEffect(() => {
    load(ws?.root || '');
  }, []);

  const recent = (() => {
    try {
      return JSON.parse(localStorage.getItem('buddo-recent') || '[]');
    } catch {
      return [];
    }
  })();

  const open = async (p) => {
    try {
      const info = await openServerFolder(p);
      localStorage.setItem('buddo-recent', JSON.stringify([info.root, ...recent.filter((r) => r !== info.root)].slice(0, 6)));
      useStore.getState().toast(`Opened ${info.name}`, 'success');
      onDone();
    } catch (e) {
      setErr(e.message);
    }
  };

  return (
    <div className="fp">
      <div className="row">
        <button className="icon-btn" title="Up" disabled={!dir?.parent} onClick={() => load(dir.parent)}>
          <ArrowUp size={16} />
        </button>
        <button className="icon-btn" title="Home" onClick={() => load(dir?.home)}>
          <Home size={16} />
        </button>
        <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load(path)} />
        {window.buddoDesktop && (
          <button
            className="btn btn-outline"
            onClick={async () => {
              const p = await window.buddoDesktop.pickFolder();
              if (p) open(p);
            }}
          >
            Browse…
          </button>
        )}
      </div>
      {err && <div className="fp-err">{err}</div>}
      {recent.length > 0 && (
        <div className="fp-recent">
          {recent.map((r) => (
            <button key={r} className="chip" onClick={() => load(r)} title={r}>
              <FolderOpen size={11} /> {r.split(/[\\/]/).pop()}
            </button>
          ))}
        </div>
      )}
      <div className="fp-list">
        {dir?.dirs.map((d, i) => (
          <motion.button
            key={d}
            className="fp-item"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: Math.min(i * 0.01, 0.2) }}
            onClick={() => load(dir.path.replace(/[\\/]$/, '') + (dir.path.includes('\\') ? '\\' : '/') + d)}
            onDoubleClick={() => open(dir.path.replace(/[\\/]$/, '') + (dir.path.includes('\\') ? '\\' : '/') + d)}
          >
            <Folder size={15} className="tree-folder" />
            <span className="truncate">{d}</span>
          </motion.button>
        ))}
        {dir && !dir.dirs.length && <div className="faint" style={{ padding: 12 }}>No subfolders</div>}
      </div>
      <div className="row">
        <button
          className="btn btn-ghost btn-sm"
          onClick={async () => {
            const name = prompt('New folder name');
            if (!name) return;
            try {
              const r = await api('/api/workspace/create', { method: 'POST', body: { parent: dir.path, name } });
              load(r.path);
            } catch (e) {
              setErr(e.message);
            }
          }}
        >
          <FolderPlus size={14} /> New folder
        </button>
        <span className="spacer" />
        {dir?.isProject && (
          <span className="chip accent">
            <Sparkles size={11} /> project detected
          </span>
        )}
        <button className="btn btn-primary" onClick={() => open(dir.path)} disabled={!dir}>
          <Check size={15} /> Open this folder
        </button>
      </div>
    </div>
  );
}

export default function FolderPicker() {
  const open = useStore((s) => s.ui.folder);
  const server = useStore((s) => s.server);
  const ws = useStore((s) => s.ws);
  const pending = useStore((s) => s.pendingHandle);
  const { setUI } = useStore.getState();
  const close = () => setUI({ folder: false });

  return (
    <Modal open={open} onClose={close} title="Open a workspace" icon={<FolderOpen size={17} />} width={620}>
      <div className="modal-body">
        {server ? (
          <ServerBrowser onDone={close} />
        ) : (
          <div className="choice-grid two">
            {pending && (
              <button
                className="choice"
                style={{ gridColumn: '1 / -1' }}
                onClick={async () => {
                  if (await reconnectFolder()) close();
                }}
              >
                <Globe size={20} />
                <b>Reconnect “{pending.name}”</b>
                <span className="faint">Grant access again to the folder you used last time</span>
              </button>
            )}
            <button
              className={'choice' + (ws?.type === 'folder' ? ' on' : '')}
              disabled={!supportsFolderAccess()}
              onClick={async () => {
                try {
                  await pickBrowserFolder();
                  close();
                } catch {}
              }}
            >
              <FolderOpen size={20} />
              <b>Open a folder</b>
              <span className="faint">{supportsFolderAccess() ? 'Read & edit a real project (Chrome / Edge)' : 'Not supported in this browser'}</span>
            </button>
            <button
              className={'choice' + (ws?.type === 'sandbox' ? ' on' : '')}
              onClick={() => {
                useSandbox();
                close();
              }}
            >
              <Box size={20} />
              <b>Browser sandbox</b>
              <span className="faint">A virtual project saved in this browser, with live preview</span>
            </button>
            <div className="upsell">
              <HardDrive size={18} />
              <div>
                <b>Unlock commands, tests & git</b>
                <div className="faint">
                  Run Buddo locally: <code>npm start</code> in the Buddo repo, <code>buddo web</code>, or use the desktop app.
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
