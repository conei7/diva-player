import { useEffect, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend
} from 'recharts';

interface ViewHistoryData {
  date: string;
  youtube: number;
  nico: number;
}

interface ViewHistoryChartProps {
  songId: number;
}

const formatJapaneseViews = (views: number): string => {
  if (views >= 100000000) {
    return (views / 100000000).toFixed(1).replace('.0', '') + '億';
  } else if (views >= 10000) {
    return (views / 10000).toFixed(1).replace('.0', '') + '万';
  }
  return views.toLocaleString();
};

export default function ViewHistoryChart({ songId }: ViewHistoryChartProps) {
  const [data, setData] = useState<ViewHistoryData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    fetch(`http://localhost:5000/api/songs/${songId}/history`)
      .then(res => res.json())
      .then((history: ViewHistoryData[]) => {
        if (active) {
          setData(history);
          setLoading(false);
        }
      })
      .catch(err => {
        console.error('Failed to fetch view history:', err);
        if (active) setLoading(false);
      });

    return () => { active = false; };
  }, [songId]);

  if (loading) {
    return (
      <div className="w-full h-[200px] flex items-center justify-center rounded-lg my-4" style={{ background: 'var(--color-bg-secondary)' }}>
        <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Loading history...</span>
      </div>
    );
  }

  if (data.length < 2) {
    return null; // Not enough data to draw a meaningful chart
  }

  return (
    <div className="w-full h-[240px] p-4 rounded-lg my-4 shadow-sm" style={{ background: 'var(--color-bg-secondary)' }}>
      <h3 className="text-sm font-bold mb-3" style={{ color: 'var(--color-text-primary)' }}>再生回数の推移</h3>
      <div className="w-full h-[160px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" vertical={false} />
            <XAxis 
              dataKey="date" 
              tick={{ fontSize: 10, fill: 'var(--color-text-muted)' }} 
              tickMargin={10}
              tickFormatter={(dateStr) => {
                const [, month, day] = dateStr.split('-');
                return `${parseInt(month)}/${parseInt(day)}`;
              }}
            />
            <YAxis 
              tick={{ fontSize: 10, fill: 'var(--color-text-muted)' }} 
              tickFormatter={formatJapaneseViews}
              domain={['auto', 'auto']}
              width={60}
            />
            <Tooltip 
              contentStyle={{ background: 'var(--color-bg-elevated)', border: 'none', borderRadius: '8px', fontSize: '12px' }}
              itemStyle={{ fontSize: '12px', fontWeight: 'bold' }}
              labelStyle={{ color: 'var(--color-text-muted)', marginBottom: '4px' }}
              formatter={(value: number, name: string) => [
                formatJapaneseViews(value), 
                name === 'youtube' ? 'YouTube' : 'ニコニコ動画'
              ]}
            />
            <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
            
            <Line 
              type="monotone" 
              dataKey="youtube" 
              name="youtube"
              stroke="#ef4444" 
              strokeWidth={2} 
              dot={{ r: 3, strokeWidth: 0, fill: '#ef4444' }} 
              activeDot={{ r: 5 }} 
            />
            <Line 
              type="monotone" 
              dataKey="nico" 
              name="nico"
              stroke="#3b82f6" 
              strokeWidth={2} 
              dot={{ r: 3, strokeWidth: 0, fill: '#3b82f6' }} 
              activeDot={{ r: 5 }} 
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
