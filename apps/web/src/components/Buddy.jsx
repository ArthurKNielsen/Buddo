import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useAnimationControls } from 'framer-motion';
import { Brain, PenLine, Hand, PartyPopper, CloudRain, MessageCircle } from 'lucide-react';
import { useStore } from '../lib/store.js';
import { describe } from './Activity.jsx';

/*
 * Buddo, the character who stands on the chat bar.
 * The face is the original logo; arms, legs and an antenna hang off it on springs.
 * A requestAnimationFrame loop runs the physics and writes SVG attributes directly,
 * so React only re-renders when his mood or speech bubble changes.
 */

// Arm angles are degrees from hanging straight down (90 = straight out, 180 = straight up, negative = across the body).
// bl/br bend the elbows, tilt leans the head, sq squashes (+) or stretches (-) the body.
const POSES = {
  idle: { l: 22, r: 22, bl: 5, br: 5, tilt: 0, sq: 0 },
  think: { l: 16, r: -36, bl: 4, br: -10, tilt: -7, sq: 0 },
  type: { l: -28, r: -28, bl: 8, br: 8, tilt: 5, sq: 0.03 },
  wait: { l: 12, r: 12, bl: -18, br: -18, tilt: 0, sq: 0 },
  happy: { l: 155, r: 155, bl: 8, br: 8, tilt: 0, sq: 0 },
  sad: { l: 6, r: 6, bl: 2, br: 2, tilt: 7, sq: 0.07 },
  shrug: { l: 75, r: 75, bl: -26, br: -26, tilt: 5, sq: 0.02 },
  sleep: { l: 8, r: 8, bl: 0, br: 0, tilt: 11, sq: 0.08 },
  wave: { l: 18, r: 150, bl: 5, br: 4, tilt: -5, sq: 0 },
  stretch: { l: 174, r: 174, bl: 0, br: 0, tilt: 0, sq: -0.14 },
  yawn: { l: 165, r: 30, bl: 0, br: 6, tilt: -9, sq: -0.06 },
  surprised: { l: 118, r: 118, bl: 0, br: 0, tilt: 0, sq: -0.06 },
  dizzy: { l: 60, r: 60, bl: 10, br: 10, tilt: 0, sq: 0.02 },
  grab: { l: 120, r: 120, bl: 0, br: 0, tilt: 0, sq: 0 },
};

const TAGS = {
  think: ['Thinking', Brain],
  type: ['Writing', PenLine],
  wait: ['Your turn', Hand],
  happy: ['Done', PartyPopper],
  sad: ['Oops', CloudRain],
  chat: ['Buddo', MessageCircle],
};

const POKES = ['Hey! That tickles.', 'Boop received.', 'Careful, I bounce.', 'Need something built?', 'Hehe. Again?', 'I was busy looking cute.'];
const CHATTER = [
  'Ready when you are.',
  'Running 100% on your machine.',
  'Tip: type @ to mention a file.',
  'Tip: / opens the commands.',
  'Tip: ⇧⇥ switches modes.',
  'Free forever. Still wild to me.',
  'Grab me and pull. I dare you.',
];

const rand = (a) => a[Math.floor(Math.random() * a.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** What the agent is doing right now, as "mode\0text" so the selector returns a stable string. */
function useAgent() {
  const key = useStore((s) => {
    const sid = s.running?.sessionId;
    if (!sid) return '';
    const sess = s.sessions.find((x) => x.id === sid);
    let item;
    for (let i = (sess?.items.length || 0) - 1; i >= 0; i--) if (sess.items[i].type === 'assistant') { item = sess.items[i]; break; }
    if (!item || item.status !== 'streaming') return 'think\0Getting ready';
    const { label, detail } = describe(item, s.webllm, s.settings.engine);
    const mode = s.permission || /^Waiting/.test(label) ? 'wait' : /^(Writing|Editing|Typing|Saving)/.test(label) ? 'type' : 'think';
    const text = mode === 'wait' ? 'Waiting for your OK' : `${label}${detail ? ` · ${detail}` : ''}`;
    return `${mode}\0${text}`;
  });
  const [mode, text] = key ? key.split('\0') : ['', ''];
  return { mode, text };
}

/** The latest assistant message in the open chat, as "id:status". */
function useLastOutcome() {
  return useStore((s) => {
    const sess = s.sessions.find((x) => x.id === s.activeId);
    for (let i = (sess?.items.length || 0) - 1; i >= 0; i--) {
      const it = sess.items[i];
      if (it.type === 'assistant') return `${it.id}:${it.status}`;
    }
    return '';
  });
}

/** Types new text in, keeping whatever prefix the old text shared. */
function useTypewriter(text, speed = 20) {
  const [n, setN] = useState(0);
  const prev = useRef('');
  useEffect(() => {
    const old = prev.current;
    prev.current = text;
    let i = 0;
    while (i < old.length && i < text.length && old[i] === text[i]) i++;
    if (reduced()) return setN(text.length);
    setN(i);
    let cur = i;
    const t = setInterval(() => {
      cur += 1;
      setN(cur);
      if (cur >= text.length) clearInterval(t);
    }, speed);
    return () => clearInterval(t);
  }, [text, speed]);
  return text.slice(0, n);
}

// File paths and names read better in mono.
const PATHY = /^[\w@.~-]*\/[\w@./~-]*$|^[\w@~-]+\.[a-z]{1,5}$/i;
function Rich({ text }) {
  return text.split(/(\s+)/).map((w, i) => (PATHY.test(w) ? <code key={i}>{w}</code> : <span key={i}>{w}</span>));
}

function Bubble({ tag, text, busy }) {
  const shown = useTypewriter(text);
  const typing = shown.length < text.length;
  const controls = useAnimationControls();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    controls.start({ scale: [1, 1.07, 0.97, 1], rotate: [0, -1.5, 1, 0], transition: { duration: 0.45 } });
  }, [text, controls]);
  const [label, Icon] = TAGS[tag] || TAGS.chat;
  return (
    <motion.div
      className={'buddy-bubble' + (busy ? ' busy' : '')}
      data-tag={tag}
      initial={{ opacity: 0, scale: 0.2, y: 16, rotate: -10 }}
      animate={{ opacity: 1, scale: 1, y: 0, rotate: 0 }}
      exit={{ opacity: 0, scale: 0.5, y: -10, filter: 'blur(3px)', transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 520, damping: 15 }}
    >
      <motion.div className="bb-card" animate={controls}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={tag}
            className="bb-tag"
            initial={{ rotateX: 90, opacity: 0 }}
            animate={{ rotateX: 0, opacity: 1 }}
            exit={{ rotateX: -90, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 24 }}
          >
            <Icon size={11} strokeWidth={2.6} />
            {label}
          </motion.span>
        </AnimatePresence>
        <span className="bb-text">
          <Rich text={shown} />
          {typing && <span className="bb-caret" />}
          {busy && !typing && (
            <span className="bb-dots">
              <i />
              <i />
              <i />
            </span>
          )}
        </span>
        {busy && <span className="bb-scan" />}
      </motion.div>
      <span className="bb-trail t1" />
      <span className="bb-trail t2" />
      <span className="bb-trail t3" />
    </motion.div>
  );
}

function Face({ mood, part }) {
  const eyes =
    mood === 'happy' || mood === 'giggle' ? (
      <>
        <path className="bd-eye-arc" d="M47.5 54 q4 -6.5 8 0" />
        <path className="bd-eye-arc" d="M64.5 54 q4 -6.5 8 0" />
      </>
    ) : mood === 'sleep' ? (
      <>
        <path className="bd-eye-arc" d="M47.5 52 q4 3.5 8 0" />
        <path className="bd-eye-arc" d="M64.5 52 q4 3.5 8 0" />
      </>
    ) : mood === 'dizzy' ? (
      <>
        <path className="bd-eye-arc" d="M48 47 l7 9 M55 47 l-7 9" />
        <path className="bd-eye-arc" d="M65 47 l7 9 M72 47 l-7 9" />
      </>
    ) : (
      <>
        <rect className="bd-eye" x="48" y="47" width="7" height="13" rx="3.5" />
        <rect className="bd-eye" x="65" y="47" width="7" height="13" rx="3.5" />
        <circle className="bd-glint" cx="53" cy="50" r="1.3" />
        <circle className="bd-glint" cx="70" cy="50" r="1.3" />
      </>
    );
  const mouth = {
    happy: <path className="bd-mouth-fill" d="M53 64.5 q7 10 14 0 z" />,
    giggle: <path className="bd-mouth-fill" d="M54 65 q6 8 12 0 z" />,
    surprised: <ellipse className="bd-mouth-fill" cx="60" cy="67.5" rx="3.4" ry="4" />,
    yawn: <ellipse className="bd-mouth-fill" cx="60" cy="67" rx="4.5" ry="5.5" />,
    think: <path className="bd-mouth" d="M57 67.5 q4 -2.2 7.5 0.4" />,
    type: <path className="bd-mouth" d="M56 66.5 q4 2.5 8 0" />,
    wait: <path className="bd-mouth" d="M56 67 h8" />,
    sad: <path className="bd-mouth" d="M55 69.5 q5 -4.5 10 0" />,
    sleep: <path className="bd-mouth" d="M57.5 67 q2.5 2 5 0" />,
    dizzy: <path className="bd-mouth" d="M53 67 q2.5 -3 5 0 t5 0 t4 0" />,
  }[mood] || <path className="bd-mouth" d="M55 66 q5 4 10 0" />;
  const brows = { think: ['M47 43 l8 1.6', 'M73 43 l-8 1.6'], sad: ['M47 44.5 l8 -2.2', 'M73 44.5 l-8 -2.2'], surprised: ['M47.5 41 q4 -2.5 8 0', 'M64.5 41 q4 -2.5 8 0'], wait: ['M47.5 43.5 h8', 'M64.5 43.5 h8'] }[mood];
  if (part === 'eyes') return eyes;
  return (
    <>
      {brows && brows.map((d) => <path key={d} className="bd-brow" d={d} />)}
      <g className={'bd-blush' + (['happy', 'giggle', 'surprised'].includes(mood) ? ' on' : '')}>
        <ellipse cx="43" cy="64" rx="4.2" ry="2.4" />
        <ellipse cx="77" cy="64" rx="4.2" ry="2.4" />
      </g>
      {mouth}
    </>
  );
}

export default function Buddy({ ducked = false }) {
  const agent = useAgent();
  const outcome = useLastOutcome();
  const [flash, setFlash] = useState(null); // { pose, mood, text, tag, strong }
  const [sleeping, setSleeping] = useState(false);
  const [grabbed, setGrabbed] = useState(false);
  const flashT = useRef(0);
  const wrap = useRef(null);
  const r = useRef({}); // svg element refs
  const sim = useRef(null);
  const live = useRef({});

  const say = (f, ms = 2600) => {
    clearTimeout(flashT.current);
    setFlash(f);
    flashT.current = setTimeout(() => setFlash(null), ms);
  };

  // Who wins: being dragged, then a strong flash (outcome), then the agent, then everything else.
  let view;
  if (grabbed) view = { pose: 'grab', mood: 'surprised', text: '' };
  else if (flash?.strong) view = flash;
  else if (agent.mode) view = { pose: agent.mode, mood: agent.mode, text: agent.text, tag: agent.mode, busy: agent.mode !== 'wait' };
  else if (flash) view = flash;
  else if (sleeping) view = { pose: 'sleep', mood: 'sleep', text: '' };
  else view = { pose: 'idle', mood: 'idle', text: '' };
  live.current = { view, agent: agent.mode, sleeping, say, setSleeping };

  // ── physics ──
  useEffect(() => {
    const S = (sim.current = {
      pose: 'idle',
      jy: 0, vy: 0, // jump (gravity)
      sq: { x: 0, v: 0 }, tilt: { x: 0, v: 0 }, lean: { x: 0, v: 0 },
      hx: { x: 0, v: 0 }, hy: { x: 0, v: 0 },
      l: { x: 22, v: 0 }, rr: { x: 22, v: 0 }, bl: { x: 5, v: 0 }, br: { x: 5, v: 0 },
      ant: { x: 0, v: 0 }, ex: { x: 0, v: 0 }, ey: { x: 0, v: 0 },
      blink: 1, nextBlink: 2, look: null, ptr: null, drag: null, lastHxV: 0, lastTiltV: 0,
    });
    const spr = (o, target, k, c, dt, f = 0) => {
      o.v += (k * (target - o.x) - c * o.v + f) * dt;
      o.x += o.v * dt;
    };
    let raf, last = performance.now(), t = 0;
    const calm = reduced();

    const frame = (now) => {
      const dt = Math.min(0.033, Math.max(0.004, (now - last) / 1000));
      last = now;
      t += dt;
      const P = POSES[S.pose] || POSES.idle;
      let tl = P.l, tr = P.r, tbl = P.bl, tbr = P.br, ttilt = P.tilt, tsq = P.sq, tlean = 0, thx = 0;
      const br = Math.sin(t * 2.1);
      if (S.pose === 'idle') { tl += br * 5; tr -= br * 5; tsq += br * 0.012; }
      if (S.pose === 'type') { const k = Math.sin(t * 24); tl += k * 13; tr -= k * 13; }
      if (S.pose === 'wave') tr += Math.sin(t * 10) * 24;
      if (S.pose === 'happy') { const k = Math.sin(t * 11); tl += k * 16; tr -= k * 16; }
      if (S.pose === 'think') ttilt += Math.sin(t * 1.3) * 2.5;
      if (S.pose === 'sleep') tsq += Math.sin(t * 1.4) * 0.035;
      if (S.pose === 'dizzy') { tlean = Math.sin(t * 5) * 9; ttilt = Math.cos(t * 5) * 8; }
      if (S.drag) {
        tsq = clamp(S.drag.dy / 150, -0.38, 0.16);
        tlean = clamp(S.drag.dx * 0.28, -24, 24);
        thx = clamp(S.drag.dx * 0.12, -10, 10);
        tl = 115 + Math.sin(t * 17) * 32;
        tr = 115 + Math.cos(t * 15) * 32;
      }

      if (calm) {
        Object.assign(S, { jy: 0, vy: 0 });
        S.sq.x = tsq; S.tilt.x = ttilt; S.lean.x = tlean; S.l.x = P.l; S.rr.x = P.r; S.bl.x = P.bl; S.br.x = P.br;
      } else {
        // gravity jump with a little bounce on landing
        if (S.jy < 0 || S.vy < 0) {
          S.vy += 1500 * dt;
          S.jy += S.vy * dt;
          if (S.jy >= 0) {
            S.sq.v += S.vy * 0.011;
            S.hy.v += S.vy * 0.35;
            S.ant.v += (Math.random() - 0.5) * 6;
            S.vy = S.vy > 260 ? -S.vy * 0.22 : 0;
            S.jy = 0;
          }
        }
        spr(S.sq, tsq, 420, 11, dt);
        spr(S.tilt, ttilt, 130, 9, dt);
        spr(S.lean, tlean, 140, 9, dt);
        spr(S.hx, thx, 190, 8, dt);
        spr(S.hy, 0, 210, 9, dt);
        spr(S.l, tl, 170, 12, dt, S.vy * -0.12);
        spr(S.rr, tr, 170, 12, dt, S.vy * -0.12);
        // floppy elbows lag behind the arm swing
        spr(S.bl, tbl, 120, 6, dt, -S.l.v * 3.2);
        spr(S.br, tbr, 120, 6, dt, -S.rr.v * 3.2);
        // antenna: a springy pendulum pushed around by the head
        const ax = (S.hx.v - S.lastHxV) / dt + ((S.tilt.v - S.lastTiltV) / dt) * 0.6 + S.lean.v * 2;
        S.lastHxV = S.hx.v;
        S.lastTiltV = S.tilt.v;
        spr(S.ant, Math.sin(t * 1.7) * 0.06 - S.tilt.x * 0.004, 70, 2.4, dt, -ax * 0.0022 - S.sq.v * 0.02);
      }

      // eyes: follow the pointer, or whatever the pose wants to look at
      let tex = 0, tey = 0;
      if (S.look && t < S.look.until) { tex = S.look.x; tey = S.look.y; }
      else if (S.pose === 'think') { tex = 2.5 + Math.sin(t * 1.1) * 2; tey = -3.5; }
      else if (S.pose === 'type') { tex = Math.sin(t * 3) * 1.5; tey = 3.5; }
      else if (S.pose === 'wait' || S.pose === 'sad' || S.pose === 'sleep') { tex = S.pose === 'wait' ? -3 : 0; tey = S.pose === 'sad' ? 3 : 0.5; }
      else if (S.ptr && wrap.current) {
        const b = wrap.current.getBoundingClientRect();
        const dx = S.ptr.x - (b.left + b.width / 2), dy = S.ptr.y - (b.top + b.height * 0.45);
        const d = Math.hypot(dx, dy) || 1;
        const k = Math.min(1, d / 160);
        tex = (dx / d) * 4.5 * k;
        tey = (dy / d) * 3.8 * k;
      }
      spr(S.ex, tex, 260, 24, dt);
      spr(S.ey, tey, 260, 24, dt);

      // blinking
      S.nextBlink -= dt;
      if (S.nextBlink <= 0) { S.blinkT = 0.16; S.nextBlink = 2.2 + Math.random() * 4 + (Math.random() < 0.2 ? -1.9 : 0); }
      if (S.blinkT > 0) S.blinkT -= dt;
      S.blink = S.blinkT > 0 ? 0.12 + Math.abs(S.blinkT - 0.08) * 10 : 1;

      // never let a bad frame poison the springs
      for (const k of ['sq', 'tilt', 'lean', 'hx', 'hy', 'l', 'rr', 'bl', 'br', 'ant', 'ex', 'ey']) if (!Number.isFinite(S[k].x) || !Number.isFinite(S[k].v)) S[k] = { x: 0, v: 0 };
      if (!Number.isFinite(S.jy) || !Number.isFinite(S.vy)) { S.jy = 0; S.vy = 0; }
      draw(S, t);
      raf = requestAnimationFrame(frame);
    };

    const draw = (S, t) => {
      const R = r.current;
      if (!R.head) return;
      const sq = S.sq.x, sx = 1 + sq * 0.55, sy = 1 - sq;
      const hx = S.hx.x, hy = S.hy.x + S.jy, tilt = S.tilt.x;
      R.all.setAttribute('transform', `rotate(${S.lean.x.toFixed(2)} 60 116)`);
      R.head.setAttribute('transform', `translate(${hx.toFixed(2)} ${hy.toFixed(2)}) rotate(${tilt.toFixed(2)} 60 76) translate(60 76) scale(${sx.toFixed(3)} ${sy.toFixed(3)}) translate(-60 -76)`);
      // legs from the (moving) hips to the feet
      const a = (tilt * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
      const fy = 110 + S.jy;
      const tap = S.pose === 'wait' ? Math.max(0, Math.sin(t * 11)) * 15 : 0;
      [[-1, 50, R.legL, R.footL], [1, 70, R.legR, R.footR]].forEach(([side, x, leg, foot]) => {
        const ox = (x - 60) * sx;
        const hipX = 60 + hx + ox * ca, hipY = 76 + hy + ox * sa - 2;
        const bow = side * (2.5 + sq * 32 + Math.abs(S.hy.x) * 0.3);
        leg.setAttribute('d', `M${hipX.toFixed(1)} ${hipY.toFixed(1)} Q${((hipX + x) / 2 + bow).toFixed(1)} ${((hipY + fy) / 2).toFixed(1)} ${x} ${fy.toFixed(1)}`);
        const rot = side > 0 ? -tap : 0;
        foot.setAttribute('transform', `translate(0 ${S.jy.toFixed(1)}) rotate(${rot} ${x + side * 6} 116)`);
      });
      // arms (inside the head group, so they ride along with it)
      [[-1, 34, S.l.x, S.bl.x, R.armL, R.handL], [1, 86, S.rr.x, S.br.x, R.armR, R.handR]].forEach(([side, sxp, ang, bend, arm, hand]) => {
        const th = (ang * Math.PI) / 180;
        const dx = side * Math.sin(th), dy = Math.cos(th);
        const L = 21, syp = 60;
        const hxp = sxp + dx * L, hyp = syp + dy * L;
        const cx = (sxp + hxp) / 2 - dy * bend * side, cy = (syp + hyp) / 2 + dx * bend * side;
        arm.setAttribute('d', `M${sxp} ${syp} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${hxp.toFixed(1)} ${hyp.toFixed(1)}`);
        hand.setAttribute('cx', hxp.toFixed(1));
        hand.setAttribute('cy', hyp.toFixed(1));
      });
      // antenna
      const an = S.ant.x;
      const tx = 60 + Math.sin(an) * 15, ty = 32 - Math.cos(an) * 15;
      R.ant.setAttribute('d', `M60 32 Q${(60 + Math.sin(an * 0.35) * 6).toFixed(1)} 24 ${tx.toFixed(1)} ${ty.toFixed(1)}`);
      R.antBall.setAttribute('cx', tx.toFixed(1));
      R.antBall.setAttribute('cy', ty.toFixed(1));
      // eyes + blink
      R.eyes.setAttribute('transform', `translate(${S.ex.x.toFixed(2)} ${S.ey.x.toFixed(2)}) translate(60 53.5) scale(1 ${S.blink.toFixed(2)}) translate(-60 -53.5)`);
      // shadow shrinks as he leaves the ground
      const lift = clamp(-S.jy / 60, 0, 1);
      R.shadow.setAttribute('rx', (26 * (1 - lift * 0.45) * sx).toFixed(1));
      R.shadow.setAttribute('opacity', (0.18 * (1 - lift * 0.6)).toFixed(3));
      // the bubble drifts with his head a little
      wrap.current?.style.setProperty('--bx', `${(hx * 0.5 + tilt * 0.4).toFixed(1)}px`);
      wrap.current?.style.setProperty('--by', `${(hy * 0.5).toFixed(1)}px`);
    };

    raf = requestAnimationFrame(frame);
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // keep the physics pose in sync with what React decided
  useEffect(() => {
    const S = sim.current;
    if (!S) return;
    if (S.pose !== view.pose && ['happy', 'surprised'].includes(view.pose)) S.vy = -330;
    if (S.pose !== view.pose && view.pose === 'stretch') S.sq.v -= 3;
    S.pose = view.pose;
  }, [view.pose]);

  // the agent starts working: a little hop
  const prevMode = useRef('');
  useEffect(() => {
    const S = sim.current;
    if (S && agent.mode && !prevMode.current) { S.vy = -240; setSleeping(false); }
    if (S && agent.mode === 'wait' && prevMode.current !== 'wait') { S.vy = -180; S.ant.v += 5; }
    prevMode.current = agent.mode;
  }, [agent.mode]);

  // a run finishes: celebrate, sulk or shrug
  const prevOutcome = useRef(outcome);
  useEffect(() => {
    const [pid, pst] = prevOutcome.current.split(':');
    const [id, st] = outcome.split(':');
    prevOutcome.current = outcome;
    if (id !== pid || pst !== 'streaming' || st === 'streaming') return;
    if (st === 'done') say({ pose: 'happy', mood: 'happy', text: rand(['All done!', 'Done. Nailed it.', 'Finished!', 'Done! Take a look.']), tag: 'happy', strong: true }, 2800);
    else if (st === 'error') say({ pose: 'sad', mood: 'sad', text: 'Hit a snag. Details are in the chat.', tag: 'sad', strong: true }, 3400);
    else if (st === 'stopped') say({ pose: 'shrug', mood: 'wait', text: 'Okay, stopped.', tag: 'chat', strong: true }, 2200);
  }, [outcome]);

  // pointer tracking, typing nods, sleep and the idle routine
  useEffect(() => {
    let lastActive = Date.now();
    const wake = () => {
      lastActive = Date.now();
      if (live.current.sleeping) {
        live.current.setSleeping(false);
        const S = sim.current;
        S.vy = -360;
        live.current.say({ pose: 'surprised', mood: 'surprised', text: 'Huh?! I\'m up, I\'m up.', tag: 'chat' }, 2000);
      }
    };
    const onMove = (e) => {
      sim.current.ptr = { x: e.clientX, y: e.clientY };
      wake();
    };
    const onKey = (e) => {
      wake();
      const el = e.target;
      if (el?.tagName === 'TEXTAREA' && el.closest('.composer') && e.key.length === 1) {
        const S = sim.current;
        S.hy.v += 55;
        S.ant.v += (Math.random() - 0.5) * 3;
        S.look = { x: (Math.random() - 0.5) * 3, y: 3.5, until: performance.now() / 1000 + 9999 };
        clearTimeout(S.lookT);
        S.lookT = setTimeout(() => (S.look = null), 1200);
      }
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('keydown', onKey);

    let idleT;
    const tick = () => {
      idleT = setTimeout(tick, 3200 + Math.random() * 3500);
      const L = live.current, S = sim.current;
      if (L.agent || L.view.pose !== 'idle' || S.drag || document.hidden || reduced()) return;
      const quiet = (Date.now() - lastActive) / 1000;
      if (quiet > 90) return L.setSleeping(true);
      const x = Math.random();
      if (quiet > 30 && x < 0.25) L.say({ pose: 'yawn', mood: 'yawn', text: '' }, 1800);
      else if (x < 0.3) {
        S.look = { x: (Math.random() - 0.5) * 9, y: (Math.random() - 0.5) * 6, until: Infinity };
        setTimeout(() => (S.look = null), 1400);
      } else if (x < 0.42) L.say({ pose: 'wave', mood: 'surprised', text: '' }, 1600);
      else if (x < 0.52) { S.vy = -220; S.ant.v += 4; }
      else if (x < 0.6) L.say({ pose: 'stretch', mood: 'happy', text: '' }, 1500);
      else if (x < 0.66) L.say({ pose: 'idle', mood: 'idle', text: rand(CHATTER), tag: 'chat' }, 3000);
    };
    idleT = setTimeout(tick, 4000);
    const hello = setTimeout(() => live.current.say({ pose: 'wave', mood: 'happy', text: 'Hey! What are we building?', tag: 'chat' }, 2800), 900);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('keydown', onKey);
      clearTimeout(idleT);
      clearTimeout(hello);
      clearTimeout(flashT.current);
    };
  }, []);

  // poke and drag
  const pokes = useRef([]);
  const onDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    sim.current.drag = { x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, moved: false };
    setSleeping(false);
  };
  const onDrag = (e) => {
    const d = sim.current.drag;
    if (!d) return;
    d.dx = e.clientX - d.x0;
    d.dy = e.clientY - d.y0;
    if (!d.moved && Math.hypot(d.dx, d.dy) > 5) {
      d.moved = true;
      setGrabbed(true);
    }
  };
  const onUp = () => {
    const S = sim.current, d = S.drag;
    if (!d) return;
    S.drag = null;
    setGrabbed(false);
    if (d.moved) {
      if (d.dy < -40) {
        S.vy = d.dy * 6;
        S.sq.v -= 4;
        say({ pose: 'surprised', mood: 'happy', text: 'Wheeee!', tag: 'chat' }, 1600);
      } else say({ pose: 'idle', mood: 'giggle', text: rand(['Boing!', 'Jelly mode.', 'That was fun.']), tag: 'chat' }, 1600);
      return;
    }
    // a poke
    const now = Date.now();
    pokes.current = [...pokes.current.filter((x) => now - x < 2500), now];
    S.sq.v += 7;
    S.hy.v += 90;
    S.ant.v += (Math.random() < 0.5 ? -1 : 1) * 7;
    if (pokes.current.length >= 5) {
      pokes.current = [];
      say({ pose: 'dizzy', mood: 'dizzy', text: 'Okay okay… the room is spinning.', tag: 'chat' }, 2600);
    } else if (agent.mode) {
      say({ pose: agent.mode, mood: 'giggle', text: '' }, 500);
    } else say({ pose: 'idle', mood: 'giggle', text: rand(POKES), tag: 'chat' }, 2200);
  };

  const ref = (k) => (el) => (r.current[k] = el);
  const text = view.text || '';
  return (
    <div className={'buddy' + (ducked ? ' ducked' : '') + (grabbed ? ' grabbed' : '')} ref={wrap} aria-hidden="true">
      <div className="buddy-bubble-anchor">
        <AnimatePresence>{text && <Bubble key="b" tag={view.tag || 'chat'} text={text} busy={!!view.busy} />}</AnimatePresence>
      </div>
      {view.pose === 'sleep' && (
        <div className="buddy-zzz">
          <span>z</span>
          <span>z</span>
          <span>Z</span>
        </div>
      )}
      <svg className="buddy-svg" viewBox="0 0 120 120">
        <defs>
          <linearGradient id="buddy-face" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" className="bd-g1" />
            <stop offset="1" className="bd-g2" />
          </linearGradient>
        </defs>
        <ellipse ref={ref('shadow')} className="bd-shadow" cx="60" cy="117" rx="26" ry="2.6" />
        <g ref={ref('all')}>
          <g className="bd-grab" onPointerDown={onDown} onPointerMove={onDrag} onPointerUp={onUp} onPointerCancel={onUp}>
            <path ref={ref('legL')} className="bd-limb" d="M50 76 L50 110" />
            <path ref={ref('legR')} className="bd-limb" d="M70 76 L70 110" />
            <g ref={ref('footL')}>
              <rect className="bd-foot" x="41" y="110" width="15" height="7" rx="3.5" />
            </g>
            <g ref={ref('footR')}>
              <rect className="bd-foot" x="64" y="110" width="15" height="7" rx="3.5" />
            </g>
            <g ref={ref('head')}>
              <path ref={ref('ant')} className="bd-limb thin" d="M60 32 L60 17" />
              <circle ref={ref('antBall')} className="bd-ant" cx="60" cy="17" r="4.4" />
              <rect className="bd-face" x="34" y="32" width="52" height="44" rx="15" />
              <rect className="bd-shine" x="34" y="32" width="52" height="44" rx="15" />
              <path className="bd-gloss" d="M41 40 q4 -4 11 -4" />
              <Face mood={view.mood} />
              <g ref={ref('eyes')}>
                <Face mood={view.mood} part="eyes" />
              </g>
              <path ref={ref('armL')} className="bd-limb" d="M34 60 L26 78" />
              <path ref={ref('armR')} className="bd-limb" d="M86 60 L94 78" />
              <circle ref={ref('handL')} className="bd-hand" cx="26" cy="78" r="5" />
              <circle ref={ref('handR')} className="bd-hand" cx="94" cy="78" r="5" />
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}
