import { PanelLeftOpen, PanelRight, FolderTree, GitCompare, TerminalSquare, ListTodo, Eye, ChevronDown } from 'lucide-react';
import { motion } from 'framer-motion';
import { useStore } from '../lib/store.js';
import { currentModel, shortModel, precisionOf } from '../lib/engine.js';

const TABS = [
  { id: 'files', icon: FolderTree, label: 'Files' },
  { id: 'changes', icon: GitCompare, label: 'Changes' },
  { id: 'terminal', icon: TerminalSquare, label: 'Terminal' },
  { id: 'tasks', icon: ListTodo, label: 'Tasks' },
  { id: 'preview', icon: Eye, label: 'Preview' },
];

export default function TopBar() {
  const ui = useStore((s) => s.ui);
  const settings = useStore((s) => s.settings);
  const engine = useStore((s) => s.engine);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const { toggleUI, setUI, openPanel } = useStore.getState();
  const changes = session?.changes.filter((c) => !c.reverted).length || 0;
  const todos = session?.todos || [];
  const todoOpen = todos.filter((t) => t.status !== 'done').length;
  const model = currentModel(settings);
  const webllm = useStore((s) => s.webllm);
  const loadedPrecision = settings.engine === 'webllm' && webllm?.loaded && shortModel(webllm.loaded) === shortModel(model) ? precisionOf(webllm.loaded) : '';
  const status = settings.engine === 'webllm' ? 'ok' : engine.status === 'ok' ? 'ok' : engine.status === 'checking' ? 'wait' : 'down';

  return (
    <header className="topbar">
      {!ui.sidebar && (
        <button className="icon-btn" title="Show sidebar (⌘B)" onClick={() => toggleUI('sidebar')}>
          <PanelLeftOpen size={17} />
        </button>
      )}
      <div className="tb-title truncate">{session?.title || 'New chat'}</div>
      <span className="spacer" />

      <motion.button className="model-pill" whileTap={{ scale: 0.97 }} onClick={() => setUI({ models: true })} title="Switch model">
        <span className={`dot ${status}`} />
        <span className="truncate mono">{model ? shortModel(model) : 'Select a model'}</span>
        {loadedPrecision && (
          <span className={'prec-chip ' + loadedPrecision} title={loadedPrecision === 'f32' ? 'Running the safe full-precision (f32) version' : 'Running the fast half-precision (f16) version'}>
            {loadedPrecision}
          </span>
        )}
        <ChevronDown size={14} className="faint" />
      </motion.button>

      <div className="tb-tabs">
        {TABS.map((t) => {
          const on = ui.panel && ui.tab === t.id;
          const badge = t.id === 'changes' ? changes : t.id === 'tasks' ? todoOpen : 0;
          return (
            <button
              key={t.id}
              className={'icon-btn' + (on ? ' active' : '')}
              title={t.label}
              onClick={() => (on ? setUI({ panel: false }) : openPanel(t.id))}
            >
              <t.icon size={16} />
              {badge > 0 && (
                <motion.span className="badge" initial={{ scale: 0 }} animate={{ scale: 1 }} key={badge}>
                  {badge}
                </motion.span>
              )}
            </button>
          );
        })}
        <div className="tb-sep" />
        <button className={'icon-btn' + (ui.panel ? ' active' : '')} title="Toggle panel (⌘J)" onClick={() => toggleUI('panel')}>
          <PanelRight size={16} />
        </button>
      </div>
    </header>
  );
}
