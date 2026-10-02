import { useState } from 'react';
import { Eye, Mic, AudioLines, Scissors, Zap } from 'lucide-react';

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

export default function MediaView({ d }) {
  const [zoom, setZoom] = useState(false);
  const m = d.meta || {};
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
        <span className="chip">
          <Zap size={11} className="speed" /> <span className="speed">{(d.ms / 1000).toFixed(1)}s</span>
        </span>
      </div>
      {d.sheet && (
        <img className={'media-sheet' + (zoom ? ' zoom' : '')} style={zoom ? {} : { maxHeight: 300, objectFit: 'contain' }} src={`data:image/jpeg;base64,${d.sheet}`} onClick={() => setZoom(!zoom)} alt="Key frames" />
      )}
      {d.image && <img className="media-img" src={`data:image/jpeg;base64,${d.image}`} alt={d.name} />}
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
