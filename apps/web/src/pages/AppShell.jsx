import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../lib/store.js';
import { initWorkspace, checkEngine } from '../lib/engine.js';
import Sidebar from '../components/Sidebar.jsx';
import TopBar from '../components/TopBar.jsx';
import ChatView from '../components/ChatView.jsx';
import Composer from '../components/Composer.jsx';
import RightPanel from '../components/RightPanel.jsx';
import CommandPalette from '../components/CommandPalette.jsx';
import SettingsModal from '../components/SettingsModal.jsx';
import SetupModal from '../components/SetupModal.jsx';
import FolderPicker from '../components/FolderPicker.jsx';
import ModelPicker from '../components/ModelPicker.jsx';
import HelpModal from '../components/HelpModal.jsx';
import Toasts from '../components/Toasts.jsx';
import { stop } from '../lib/runner.js';

function useTheme() {
  const theme = useStore((s) => s.settings.theme);
  const accent = useStore((s) => s.settings.accent);
  useEffect(() => {
    const apply = () => {
      const t = theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
      document.documentElement.dataset.theme = t;
    };
    apply();
    document.documentElement.dataset.accent = accent;
    if (theme === 'system') {
      const mq = matchMedia('(prefers-color-scheme: light)');
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [theme, accent]);
}

export default function AppShell() {
  useTheme();
  const ui = useStore((s) => s.ui);
  const engine = useStore((s) => s.settings.engine);

  useEffect(() => {
    document.title = 'Buddo';
    if (window.innerWidth < 860) useStore.getState().setUI({ sidebar: false });
    (async () => {
      await initWorkspace();
      const ok = await checkEngine();
      const st = useStore.getState();
      if (!st.settings.onboarded || (!ok && st.settings.engine !== 'webllm')) st.setUI({ setup: true });
    })();
  }, []);

  useEffect(() => {
    checkEngine();
  }, [engine]);

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const st = useStore.getState();
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        st.toggleUI('palette');
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        st.toggleUI('sidebar');
      } else if (mod && e.key === 'j') {
        e.preventDefault();
        st.toggleUI('panel');
      } else if (mod && e.key === ',') {
        e.preventDefault();
        st.setUI({ settings: true });
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        st.newChat();
      } else if (e.key === 'Escape' && st.running && !st.permission && !st.ui.palette) {
        stop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <div className="app-glow" />
      <AnimatePresence initial={false}>
        {ui.sidebar && (
          <motion.aside
            key="sidebar"
            className="sidebar-wrap"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 268, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 38 }}
          >
            <Sidebar />
          </motion.aside>
        )}
      </AnimatePresence>
      <main className="main">
        <TopBar />
        <ChatView />
        <Composer />
      </main>
      <AnimatePresence initial={false}>
        {ui.panel && (
          <motion.aside
            key="panel"
            className="panel-wrap"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 'var(--panel-w)', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 38 }}
          >
            <RightPanel />
          </motion.aside>
        )}
      </AnimatePresence>

      <CommandPalette />
      <SettingsModal />
      <SetupModal />
      <FolderPicker />
      <ModelPicker />
      <HelpModal />
      <Toasts />
    </div>
  );
}
