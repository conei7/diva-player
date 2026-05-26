import { useEffect, useState, useMemo } from 'react';

interface ViewHistoryData {
  date: string;
  youtube: number;
  nico: number;
}

const formatJapaneseViews = (views: number): string => {
  if (views >= 100000000) {
    return (views / 100000000).toFixed(1).replace('.0', '') + '億';
  } else if (views >= 10000) {
    return (views / 10000).toFixed(1).replace('.0', '') + '万';
  }
  return views.toLocaleString();
};

export default function ViewHistoryChart({ songId }: { songId: number }) {
  const [data, setData] = useState<ViewHistoryData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    fetch(`http://localhost:5000/api/songs/${songId}/history`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return res.json();
      })
      .then((history: ViewHistoryData[]) => {
        if (active) {
          setData(Array.isArray(history) ? history : []);
          setLoading(false);
        }
      })
      .catch(err => {
        console.error('Failed to fetch view history:', err);
        if (active) setLoading(false);
      });

    return () => { active = false; };
  }, [songId]);

  const { pointsYoutube, pointsNico, xLabels, yMax } = useMemo(() => {
    if (data.length < 2) return { pointsYoutube: '', pointsNico: '', xLabels: [], yMax: 0 };
    
    const maxYoutube = Math.max(...data.map(d => d.youtube));
    const maxNico = Math.max(...data.map(d => d.nico));
    const yMax = Math.max(maxYoutube, maxNico) * 1.1; // 10% padding
    
    const width = 100; // percentages
    const height = 100;
    
    const getX = (index: number) => (index / (data.length - 1)) * width;
    const getY = (val: number) => height - (val / yMax) * height;

    const pointsYoutube = data.map((d, i) => `${getX(i)},${getY(d.youtube)}`).join(' ');
    const pointsNico = data.map((d, i) => `${getX(i)},${getY(d.nico)}`).join(' ');
    
    // Pick ~4 labels max for X axis
    const step = Math.max(1, Math.floor(data.length / 4));
    const xLabels = data.filter((_, i) => i % step === 0 || i === data.length - 1).map((d, i, arr) => {
      // Avoid duplicate last label
      if (i > 0 && i === arr.length - 1 && data.length % step < step / 2) return null;
      const [, month, day] = d.date.split('-');
      return { x: getX(data.indexOf(d)), label: `${parseInt(month)}/${parseInt(day)}` };
    }).filter(Boolean);

    return { pointsYoutube, pointsNico, xLabels, yMax };
  }, [data]);

  if (loading) {
    return (
      <div className="w-full h-[180px] flex items-center justify-center rounded-lg my-4" style={{ background: 'var(--color-bg-secondary)' }}>
        <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Loading history...</span>
      </div>
    );
  }

  if (data.length < 2) {
    return (
      <div className="w-full h-[180px] p-4 rounded-lg my-4 shadow-sm flex flex-col items-center justify-center text-center" style={{ background: 'var(--color-bg-secondary)' }}>
        <h3 className="text-sm font-bold mb-2" style={{ color: 'var(--color-text-primary)' }}>再生回数の推移</h3>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          データ蓄積中です。<br/>
          （明日以降、バッチ処理が完了するとグラフが表示されます）
        </span>
      </div>
    );
  }

  return (
    <div className="w-full h-[220px] p-4 rounded-lg my-4 shadow-sm flex flex-col" style={{ background: 'var(--color-bg-secondary)' }}>
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-sm font-bold" style={{ color: 'var(--color-text-primary)' }}>再生回数の推移</h3>
        <div className="flex gap-4 text-xs font-semibold">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: '#ef4444' }}></span> YouTube</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: '#3b82f6' }}></span> ニコニコ動画</span>
        </div>
      </div>
      
      <div className="relative flex-grow ml-10 mb-5">
        {/* Y Axis max label */}
        <div className="absolute -left-12 top-0 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{formatJapaneseViews(yMax)}</div>
        <div className="absolute -left-12 bottom-0 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>0</div>
        
        {/* Background Grid */}
        <div className="absolute inset-0 border-b border-l border-[rgba(255,255,255,0.1)]"></div>
        <div className="absolute inset-x-0 top-1/2 border-b border-dashed border-[rgba(255,255,255,0.05)]"></div>
        
        {/* SVG Chart */}
        <svg className="absolute inset-0 w-full h-full overflow-visible" preserveAspectRatio="none">
          <polyline fill="none" stroke="#ef4444" strokeWidth="2" points={pointsYoutube} vectorEffect="non-scaling-stroke" />
          <polyline fill="none" stroke="#3b82f6" strokeWidth="2" points={pointsNico} vectorEffect="non-scaling-stroke" />
          
          {data.map((d, i) => {
            const x = (i / (data.length - 1)) * 100;
            const yy = 100 - (d.youtube / yMax) * 100;
            const yn = 100 - (d.nico / yMax) * 100;
            return (
              <g key={i}>
                <circle cx={`${x}%`} cy={`${yy}%`} r="3" fill="#ef4444" />
                <circle cx={`${x}%`} cy={`${yn}%`} r="3" fill="#3b82f6" />
              </g>
            );
          })}
        </svg>
        
        {/* X Axis Labels */}
        {xLabels.map((l, i) => l && (
          <div key={i} className="absolute -bottom-5 text-[10px] transform -translate-x-1/2" style={{ left: `${l.x}%`, color: 'var(--color-text-muted)' }}>
            {l.label}
          </div>
        ))}
      </div>
    </div>
  );
}
