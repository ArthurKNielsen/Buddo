import { useEffect, useState } from 'react';
import { getWorkspace } from '../lib/engine.js';
import { mediaUrl } from '../lib/workspaces.js';
import { Eye, Mic, AudioLines, Scissors, Zap, AlertTriangle, CheckCircle2, MousePointerClick, Film } from 'lucide-react';

const fmt = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

function Hearing({ h }) {
  if (!h) return null;
  const env = h.loudness?.envelope || [];
  const step = Math.max(1, Math.ceil(env.length / 120));
  const bars = env.filter((_, i) => i % step === 0);
  return (
    <>
      {h.speech && (
        <div>
          <h5>
            <Mic size={12} /> Heard speech{h.speech.language ? ` · ${h.speech.language}` : ''}
          </h5>
          {h.speech.segments.length ? (
            <div className="media-lines">
              {h.speech.segments.map((s, i) => (
                <div key={i}>
                  <span className="ts">{fmt(s.start)}</span>
                  <span>{s.text}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="faint" style={{ fontSize: 12.5 }}>No speech</div>
          )}
        </div>
      )}
      {h.sounds?.overall?.length > 0 && (
        <div>
          <h5>
            <AudioLines size={12} /> Heard sounds
          </h5>
          <div className="sound-chips">
            {h.sounds.overall.slice(0, 6).map((s) => (
              <span key={s.label} className="sound-chip">
                {s.label} <b>{Math.round(s.prob * 100)}%</b>
              </span>
            ))}
          </div>
        </div>
      )}
      {bars.length > 1 && (
        <div title={`Loudness (avg ${h.loudness.avgDb} dB)`}>
          <h5>Loudness</h5>
          <div className="loud">
            {bars.map((db, i) => (
              <span key={i} style={{ height: `${Math.max(4, Math.min(100, (db + 60) * 1.7))}%` }} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function PageReport({ d }) {
  const r = d.report;
  if (!r) return null;
  const issues = [
    r.overflowX ? `Page is ${r.overflowX}px wider than the screen${r.overflow?.length ? ` — ${r.overflow[0]}` : ''}` : null,
    r.brokenImages?.length ? `Broken images: ${r.brokenImages.join(', ')}` : null,
    r.empty ? 'Page looks empty' : null,
    ...(d.logs || []).filter((l) => l.type === 'error').slice(0, 3).map((l) => `Console: ${l.text.slice(0, 120)}`),
  ].filter(Boolean);
  return (
    <>
      {d.steps?.length > 0 && (
        <div>
          <h5>
            <MousePointerClick size={12} /> Did
          </h5>
          <div className="media-lines">
            {d.steps.map((s, i) => (
              <div key={i} className={s.startsWith('FAILED') ? 'err' : ''}>
                <span className="ts">{i + 1}.</span>
                <span>{s}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div>
        <h5>{issues.length ? <AlertTriangle size={12} className="warn" /> : <CheckCircle2 size={12} className="ok" />} {issues.length ? `Noticed ${issues.length} issue${issues.length > 1 ? 's' : ''}` : 'Looks healthy'}</h5>
        {issues.length > 0 && (
          <div className="media-lines">
            {issues.map((x, i) => (
              <div key={i} className="warn-line">• {x}</div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** Play a video Buddo made or edited, straight from the project folder. */
function MadeVideo({ path }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let made = null;
    let live = true;
    const ws = getWorkspace();
    if (ws) mediaUrl(ws, path).then((u) => (live ? setUrl((made = u)) : u?.startsWith('blob:') && URL.revokeObjectURL(u))).catch(() => {});
    return () => {
      live = false;
      if (made?.startsWith('blob:')) URL.revokeObjectURL(made);
    };
  }, [path]);
  if (!url) return null;
  return /\.gif$/i.test(path) ? <img className="media-player" src={url} alt={path} /> : <video className="media-player" src={url} controls playsInline preload="metadata" />;
}

export default function MediaView({ d }) {
  const [zoom, setZoom] = useState(false);
  const m = d.meta || {};
  if (d.kind === 'screenshot') {
    return (
      <div className="media">
        <div className="media-meta">
          <span className="chip">{d.size?.join('×')}</span>
          {d.report?.title && <span className="chip">“{d.report.title}”</span>}
          <span className="chip">
            <Zap size={11} className="speed" /> <span className="speed">{(d.ms / 1000).toFixed(1)}s</span>
          </span>
        </div>
        {d.image && <img className={'media-shot' + (d.size?.[0] < 600 ? ' phone' : '')} src={`data:image/jpeg;base64,${d.image}`} alt="Screenshot" />}
        <PageReport d={d} />
      </div>
    );
  }
  return (
    <div className="media">
      <div className="media-meta">
        {m.duration > 0 && <span className="chip">{fmt(m.duration)}</span>}
        {m.width && (
          <span className="chip">
            {m.width}×{m.height}
          </span>
        )}
        {d.kind === 'video' && <span className="chip">{m.audio ? 'with audio' : 'no audio'}</span>}
        {d.saved && (
          <span className="chip">
            <Film size={11} /> {d.saved}
          </span>
        )}
        <span className="chip">
          <Zap size={11} className="speed" /> <span className="speed">{(d.ms / 1000).toFixed(1)}s</span>
        </span>
      </div>
      {d.kind === 'made' && <MadeVideo path={d.saved} />}
      {d.sheet && (
        <img className={'media-sheet' + (zoom ? ' zoom' : '')} style={zoom ? {} : { maxHeight: 300, objectFit: 'contain' }} src={`data:image/jpeg;base64,${d.sheet}`} onClick={() => setZoom(!zoom)} alt="Key frames" />
      )}
      {d.image && <img className="media-img" src={`data:image/jpeg;base64,${d.image}`} alt={d.name} />}
      {d.kind === 'recording' && <PageReport d={d} />}
      {d.kind === 'video' && (
        <div>
          <h5>
            <Eye size={12} /> Saw
          </h5>
          {d.cuts?.length > 0 && (
            <div className="faint" style={{ fontSize: 12, marginBottom: 6 }}>
              <Scissors size={11} /> Cuts at {d.cuts.map(fmt).join(', ')}
            </div>
          )}
          <div className="media-frames">
            {d.frames.map((f, i) => (
              <div key={i} style={{ display: 'contents' }}>
                <span className="ts">{fmt(f.t)}</span>
                <span>{f.objects}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {d.kind === 'image' && (
        <div>
          <h5>
            <Eye size={12} /> Saw
          </h5>
          <div className="sound-chips">
            {d.objects.length ? (
              d.objects.slice(0, 12).map((o, i) => (
                <span key={i} className="sound-chip">
                  {o.label} <b>{Math.round(o.score * 100)}%</b> <span className="faint">{o.where}</span>
                </span>
              ))
            ) : (
              <span className="faint" style={{ fontSize: 12.5 }}>No common objects detected</span>
            )}
          </div>
        </div>
      )}
      <Hearing h={d.hearing} />
    </div>
  );
}
