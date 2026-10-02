import { useEffect, useRef, useState } from 'react';
import { motion, useScroll, useTransform, AnimatePresence } from 'framer-motion';
import {
  ArrowRight, Github, Download, Terminal, Globe, Monitor, Shield, Zap, Heart, FileCode2, GitCompare, ListTodo, Eye, Brain, Command,
  Undo2, Plug, Check, X, ChevronDown, Copy, Sparkles, Cpu, Laptop,
} from 'lucide-react';
import Logo from '../components/Logo.jsx';
import { navigate } from '../App.jsx';
import { href } from '../lib/paths.js';

const GITHUB = 'https://github.com/arthurknielsen/buddo';

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] },
};

// ───────── animated terminal demo ─────────
const SCRIPT = [
  { t: 'cmd', text: 'buddo "add a dark mode toggle to the navbar"' },
  { t: 'think', text: 'Cooking…' },
  { t: 'tool', name: 'Search', arg: '/navbar/i', res: 'Found 3 matches' },
  { t: 'tool', name: 'Read', arg: 'src/components/Navbar.jsx', res: 'Read 84 lines' },
  { t: 'todo', items: ['Add theme state + persistence', 'Add toggle button to Navbar', 'Add dark CSS variables', 'Run the tests'] },
  { t: 'tool', name: 'Update', arg: 'src/components/Navbar.jsx', res: 'Updated with +18 -2', diff: ['+  const [dark, setDark] = useTheme();', '+  <button onClick={() => setDark(!dark)}>', '+    {dark ? <Sun /> : <Moon />}'] },
  { t: 'tool', name: 'Write', arg: 'src/hooks/useTheme.js', res: 'Created with +21' },
  { t: 'tool', name: 'Bash', arg: 'npm test', res: '✓ 24 passed' },
  { t: 'text', text: 'Done! Added a dark mode toggle that remembers your choice. ✨' },
];

function TerminalDemo() {
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    const cur = SCRIPT[step];
    if (!cur) {
      const t = setTimeout(() => {
        setStep(0);
        setTyped('');
      }, 3800);
      return () => clearTimeout(t);
    }
    if (cur.t === 'cmd' && typed.length < cur.text.length) {
      const t = setTimeout(() => setTyped(cur.text.slice(0, typed.length + 1)), 28 + Math.random() * 40);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStep((s) => s + 1), cur.t === 'cmd' ? 500 : cur.t === 'think' ? 900 : 700);
    return () => clearTimeout(t);
  }, [step, typed]);

  const shown = SCRIPT.slice(1, step + 1).filter(Boolean);
  const body = useRef(null);
  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight, behavior: 'smooth' });
  }, [step]);

  return (
    <div className="term-demo">
      <div className="td-bar">
        <span className="td-dot r" />
        <span className="td-dot y" />
        <span className="td-dot g" />
        <span className="td-title">~/projects/my-app — buddo</span>
      </div>
      <div className="td-body" ref={body}>
        <div className="td-line">
          <span className="td-prompt">❯</span> {step === 0 ? typed : SCRIPT[0].text}
          {step === 0 && <span className="td-caret" />}
        </div>
        <AnimatePresence>
          {shown.map((s, i) => {
            const last = i === shown.length - 1 && step < SCRIPT.length;
            if (s.t === 'think')
              return last ? (
                <motion.div key={i} className="td-line td-think" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <span className="td-spin">✻</span> <span className="shimmer">{s.text}</span>
                </motion.div>
              ) : null;
            if (s.t === 'tool')
              return (
                <motion.div key={i} className="td-tool" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}>
                  <div>
                    <span className="td-bullet">⏺</span> <b>{s.name}</b>
                    <span className="td-dim">(</span>
                    {s.arg}
                    <span className="td-dim">)</span>
                  </div>
                  <div className="td-res">⎿ {s.res}</div>
                  {s.diff && (
                    <div className="td-diff">
                      {s.diff.map((d) => (
                        <div key={d}>{d}</div>
                      ))}
                    </div>
                  )}
                </motion.div>
              );
            if (s.t === 'todo')
              return (
                <motion.div key={i} className="td-tool" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}>
                  <div>
                    <span className="td-bullet">⏺</span> <b>Todos</b>
                  </div>
                  {s.items.map((it, k) => (
                    <div key={it} className="td-res">
                      {k === 0 ? '⎿' : ' '} {step > i + 1 + k ? <span className="td-ok">☒ <s>{it}</s></span> : `☐ ${it}`}
                    </div>
                  ))}
                </motion.div>
              );
            return (
              <motion.div key={i} className="td-line td-final" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                <span className="td-bullet v">⏺</span> {s.text}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ───────── pieces ─────────
function GlowCard({ children, className = '' }) {
  const ref = useRef(null);
  return (
    <motion.div
      ref={ref}
      className={'glow-card ' + className}
      onMouseMove={(e) => {
        const r = ref.current.getBoundingClientRect();
        ref.current.style.setProperty('--mx', `${e.clientX - r.left}px`);
        ref.current.style.setProperty('--my', `${e.clientY - r.top}px`);
      }}
      {...reveal}
    >
      {children}
    </motion.div>
  );
}

function CopyCmd({ cmd }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="copy-cmd"
      onClick={() => {
        navigator.clipboard?.writeText(cmd);
        setOk(true);
        setTimeout(() => setOk(false), 1500);
      }}
    >
      <span className="td-prompt">$</span>
      <code>{cmd}</code>
      <span className="copy-cmd-icon">{ok ? <Check size={14} /> : <Copy size={14} />}</span>
    </button>
  );
}

const FEATURES = [
  { icon: Heart, title: 'Free. Actually free.', desc: 'No API keys, tokens, credits or subscriptions. Runs open models like Qwen, Llama and DeepSeek on your own hardware.', big: true },
  { icon: Shield, title: 'Private by default', desc: 'Your code never leaves your machine. Works fully offline once a model is downloaded.' },
  { icon: Brain, title: 'A real agent', desc: 'Explores your repo, plans with a live todo list, edits files, runs tests and iterates until it works.' },
  { icon: GitCompare, title: 'Beautiful diffs + one-click revert', desc: 'Review every change with syntax-highlighted diffs. Undo any file instantly.' },
  { icon: Terminal, title: 'Runs your commands', desc: 'Tests, builds, git, installs — with your approval, streamed live into an integrated terminal.' },
  { icon: Brain, title: 'Watches, hears & sees', desc: 'Give it a video, audio or image: it finds the scenes, reads the speech, recognizes sounds and objects — in about a second, locally.' },
  { icon: Eye, title: 'Live preview', desc: 'Building a website? See it render right next to the chat as Buddo writes it.' },
  { icon: Shield, title: 'Permission modes', desc: 'Ask, Auto-edit, YOLO or read-only Plan mode. You stay in control.' },
  { icon: Command, title: 'Slash commands & ⌘K', desc: '/init, /review, /test, /fix, /commit, /plan and more. Command palette for everything.' },
  { icon: FileCode2, title: '@-mention files', desc: 'Pull any file into context instantly. Drop in attachments. Project memory via BUDDO.md.' },
  { icon: Plug, title: 'Bring any local engine', desc: 'Ollama, LM Studio, llama.cpp, Jan — or zero-install in-browser models via WebGPU.' },
];

const COMPARE = [
  ['Price', '$0 forever', '$20–$200 / mo'],
  ['API key required', 'No', 'Yes'],
  ['Works offline', 'Yes', 'No'],
  ['Code leaves your machine', 'Never', 'Every request'],
  ['Usage limits', 'None', 'Rate limited'],
  ['Open source', 'MIT', 'Mostly closed'],
];

const FAQ = [
  ['Is Buddo really free?', 'Yes. Buddo runs open-weight AI models locally through free tools like Ollama. There is no server we pay for, so there is nothing to charge you for.'],
  ['How smart is it?', 'It depends on the model you run. Qwen 2.5 Coder 7B is great on most laptops; with 32 GB+ RAM, models like Qwen 3 Coder 30B get seriously capable. Buddo’s agent loop — exploring, planning, verifying with tests — squeezes the most out of whatever you run.'],
  ['What do I need?', 'Any modern Mac, Windows or Linux machine. 8 GB RAM works for small models; 16 GB+ is recommended. Or try it right in Chrome/Edge with in-browser models — no install at all.'],
  ['Can it break my project?', 'In Ask mode every edit and command needs your approval, and every change can be reverted in one click from the Changes panel. Plan mode is fully read-only.'],
  ['Web, desktop or terminal?', 'All three share the same brain. The web app works anywhere; run it locally (or use the desktop app) to unlock commands, tests and git. Terminal fans get the `buddo` CLI.'],
];

export default function Landing() {
  const { scrollY } = useScroll();
  const heroY = useTransform(scrollY, [0, 600], [0, 120]);
  const heroO = useTransform(scrollY, [0, 500], [1, 0.2]);
  const [scrolled, setScrolled] = useState(false);
  const [faq, setFaq] = useState(0);
  useEffect(() => scrollY.on('change', (v) => setScrolled(v > 20)), [scrollY]);
  useEffect(() => {
    document.title = 'Buddo — your free AI coding buddy';
    document.documentElement.dataset.theme = 'dark';
  }, []);
  const openApp = (e) => {
    e?.preventDefault();
    navigate('/app');
  };

  return (
    <div className="landing">
      <div className="l-bg">
        <div className="blob b1" />
        <div className="blob b2" />
        <div className="blob b3" />
        <div className="l-grid" />
      </div>

      <nav className={'l-nav' + (scrolled ? ' scrolled' : '')}>
        <a className="brand" href={href('/')}>
          <Logo size={28} />
          <span className="brand-name">buddo</span>
        </a>
        <div className="l-links">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#download">Download</a>
          <a href="#faq">FAQ</a>
        </div>
        <div className="row">
          <a className="icon-btn" href={GITHUB} target="_blank" rel="noreferrer" title="GitHub">
            <Github size={18} />
          </a>
          <a href={href('/app')} onClick={openApp} className="btn btn-primary btn-sm">
            Open app <ArrowRight size={14} />
          </a>
        </div>
      </nav>

      <header className="hero">
        <motion.div style={{ y: heroY, opacity: heroO }} className="hero-copy">
          <motion.div className="hero-badge" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <Sparkles size={13} /> 100% free · no API keys · runs on your machine
          </motion.div>
          <motion.h1 initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}>
            Your AI coding buddy.
            <br />
            <span className="grad-text hero-grad">Free forever.</span>
          </motion.h1>
          <motion.p initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.28, duration: 0.7 }}>
            Buddo is an autonomous coding agent that reads your codebase, writes features, fixes bugs and runs your tests — powered by open AI models running locally. No accounts. No bills. No data leaving your laptop.
          </motion.p>
          <motion.div className="hero-ctas" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.38 }}>
            <a href={href('/app')} onClick={openApp} className="btn btn-primary btn-lg">
              Start building — it's free <ArrowRight size={16} />
            </a>
            <a href="#download" className="btn btn-outline btn-lg">
              <Download size={16} /> Download
            </a>
          </motion.div>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }}>
            <CopyCmd cmd="git clone https://github.com/arthurknielsen/buddo && cd buddo && npm i && npm start" />
          </motion.div>
        </motion.div>

        <motion.div className="hero-demo" initial={{ opacity: 0, y: 40, rotateX: 12 }} animate={{ opacity: 1, y: 0, rotateX: 0 }} transition={{ delay: 0.35, duration: 0.9, ease: [0.22, 1, 0.36, 1] }}>
          <div className="hero-demo-glow" />
          <TerminalDemo />
        </motion.div>
      </header>

      <motion.section className="works-with" {...reveal}>
        <span className="faint">Runs the best open models via</span>
        <div className="ww-list">
          {['Ollama', 'LM Studio', 'llama.cpp', 'WebGPU', 'Qwen', 'Llama', 'DeepSeek', 'gpt-oss'].map((n, i) => (
            <motion.span key={n} className="ww" initial={{ opacity: 0, y: 8 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.05 }}>
              {n}
            </motion.span>
          ))}
        </div>
      </motion.section>

      <section id="features" className="l-section">
        <motion.div className="l-head" {...reveal}>
          <span className="eyebrow">Features</span>
          <h2>Everything you love about AI coding agents.</h2>
          <p className="muted">Minus the invoice.</p>
        </motion.div>
        <div className="bento">
          {FEATURES.map((f) => (
            <GlowCard key={f.title} className={f.big ? 'big' : ''}>
              <div className="gc-icon">
                <f.icon size={18} />
              </div>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
              {f.big && (
                <div className="price-tag">
                  <span className="price">$0</span>
                  <span className="faint">/ forever</span>
                </div>
              )}
            </GlowCard>
          ))}
        </div>
      </section>

      <section id="how" className="l-section">
        <motion.div className="l-head" {...reveal}>
          <span className="eyebrow">How it works</span>
          <h2>Up and running in three steps.</h2>
        </motion.div>
        <div className="steps-row">
          {[
            [Cpu, 'Get a free engine', 'Install Ollama (one click) — or skip it and run models in your browser.'],
            [Download, 'Pick a model', 'Buddo downloads a recommended coding model for you. One time, ~2–5 GB.'],
            [Zap, 'Start building', 'Open a folder and tell Buddo what you want. Watch it plan, code and test.'],
          ].map(([I, t, d], i) => (
            <motion.div key={t} className="step-card" {...reveal} transition={{ ...reveal.transition, delay: i * 0.1 }}>
              <div className="step-num">{i + 1}</div>
              <I size={22} className="step-icon" />
              <h3>{t}</h3>
              <p className="muted">{d}</p>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="l-section">
        <motion.div className="l-head" {...reveal}>
          <span className="eyebrow">Compare</span>
          <h2>Why pay to code with AI?</h2>
        </motion.div>
        <motion.div className="compare" {...reveal}>
          <div className="cmp-row cmp-head">
            <span />
            <span className="cmp-us">
              <Logo size={20} animated={false} /> Buddo
            </span>
            <span className="faint">Paid AI agents</span>
          </div>
          {COMPARE.map(([k, a, b]) => (
            <div key={k} className="cmp-row">
              <span className="muted">{k}</span>
              <span className="cmp-us">
                <Check size={15} className="ok" /> {a}
              </span>
              <span className="faint">
                <X size={15} /> {b}
              </span>
            </div>
          ))}
        </motion.div>
      </section>

      <section id="download" className="l-section">
        <motion.div className="l-head" {...reveal}>
          <span className="eyebrow">Get Buddo</span>
          <h2>Use it wherever you code.</h2>
        </motion.div>
        <div className="dl-grid">
          <GlowCard>
            <div className="gc-icon">
              <Globe size={18} />
            </div>
            <h3>Web app</h3>
            <p>Open it in your browser. Edit local folders or a sandbox, with zero-install in-browser models.</p>
            <a href={href('/app')} onClick={openApp} className="btn btn-primary">
              Open Buddo <ArrowRight size={14} />
            </a>
          </GlowCard>
          <GlowCard>
            <div className="gc-icon">
              <Laptop size={18} />
            </div>
            <h3>Desktop app</h3>
            <p>macOS, Windows & Linux. Full power: file editing, terminal, tests and git built in.</p>
            <a href={`${GITHUB}/releases`} target="_blank" rel="noreferrer" className="btn btn-outline">
              <Monitor size={14} /> Download desktop
            </a>
          </GlowCard>
          <GlowCard>
            <div className="gc-icon">
              <Terminal size={18} />
            </div>
            <h3>Terminal CLI</h3>
            <p>Live in your shell? <code>buddo</code> brings the agent to the terminal with diffs, todos and approvals.</p>
            <CopyCmd cmd="npm run link && buddo" />
          </GlowCard>
        </div>
      </section>

      <section id="faq" className="l-section faq">
        <motion.div className="l-head" {...reveal}>
          <span className="eyebrow">FAQ</span>
          <h2>Questions, answered.</h2>
        </motion.div>
        <div className="faq-list">
          {FAQ.map(([q, a], i) => (
            <motion.div key={q} className={'faq-item' + (faq === i ? ' open' : '')} {...reveal}>
              <button onClick={() => setFaq(faq === i ? -1 : i)}>
                {q}
                <motion.span animate={{ rotate: faq === i ? 180 : 0 }}>
                  <ChevronDown size={18} />
                </motion.span>
              </button>
              <AnimatePresence initial={false}>
                {faq === i && (
                  <motion.p initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3 }}>
                    {a}
                  </motion.p>
                )}
              </AnimatePresence>
            </motion.div>
          ))}
        </div>
      </section>

      <motion.section className="cta-final" {...reveal}>
        <div className="cta-glow" />
        <Logo size={64} />
        <h2>Ready to meet your buddy?</h2>
        <p className="muted">Free forever. Open source. Takes two minutes.</p>
        <a href={href('/app')} onClick={openApp} className="btn btn-primary btn-lg">
          Launch Buddo <ArrowRight size={16} />
        </a>
      </motion.section>

      <footer className="l-foot">
        <div className="brand">
          <Logo size={22} animated={false} />
          <span className="brand-name" style={{ fontSize: 15 }}>
            buddo
          </span>
        </div>
        <span className="faint">MIT licensed · made for everyone who codes</span>
        <a href={GITHUB} target="_blank" rel="noreferrer" className="faint row">
          <Github size={14} /> GitHub
        </a>
      </footer>
    </div>
  );
}
