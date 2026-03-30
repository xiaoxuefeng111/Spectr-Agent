/**
 * 用量仪表盘 - Token 消耗趋势与会话用量分布
 * @author weibin
 */

import { useState, useEffect, useCallback } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend
} from 'recharts'
import { Zap, Clock, TrendingUp, RefreshCw } from 'lucide-react'

interface UsageSummary {
  totalTokens: number
  totalMinutes: number
  todayTokens: number
  todayMinutes: number
  activeSessions: number
  sessionBreakdown: Record<string, number>
}

interface DailyStat {
  date: string
  tokens: number
  minutes: number
  sessions: number
}

interface SessionStat {
  sessionId: string
  sessionName: string
  tokens: number
  minutes: number
}

const PIE_COLORS = ['#58A6FF', '#3FB950', '#D29922', '#BC8CFF', '#F85149', '#8B949E', '#79C0FF', '#56D364']

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatMinutes(m: number): string {
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const min = m % 60
    return min > 0 ? `${h}h ${min}m` : `${h}h`
  }
  return `${m}m`
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export default function UsageDashboard() {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [dailyStats, setDailyStats] = useState<DailyStat[]>([])
  const [sessionStats, setSessionStats] = useState<SessionStat[]>([])
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    try {
      const [summaryData, historyData] = await Promise.all([
        window.spectrAI.usage.getSummary(),
        window.spectrAI.usage.getHistory(30)
      ])
      setSummary(summaryData)
      setDailyStats(historyData.dailyStats || [])
      setSessionStats(historyData.sessionStats || [])
    } catch (err) {
      console.error('[UsageDashboard] fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const timer = setInterval(fetchData, 30_000)
    return () => clearInterval(timer)
  }, [fetchData])

  // 柱状图的自定义 Tooltip
  const BarTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null
    return (
      <div className="bg-bg-secondary border border-border rounded px-3 py-2 text-xs shadow-lg">
        <div className="text-text-primary font-medium mb-1">{label}</div>
        {payload.map((entry: any, idx: number) => (
          <div key={idx} className="flex items-center gap-2" style={{ color: entry.color }}>
            <span>{entry.name === 'tokens' ? 'Token' : '时长'}: </span>
            <span className="font-medium">
              {entry.name === 'tokens' ? formatTokens(entry.value) : formatMinutes(entry.value)}
            </span>
          </div>
        ))}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        加载用量数据...
      </div>
    )
  }

  // 饼图数据：取前 7 个会话，其余归入"其他"
  const pieData = (() => {
    if (sessionStats.length === 0) return []
    const top = sessionStats.slice(0, 7)
    const rest = sessionStats.slice(7)
    const result = top.map(s => ({
      name: s.sessionName.length > 12 ? s.sessionName.slice(0, 12) + '...' : s.sessionName,
      value: s.tokens
    }))
    if (rest.length > 0) {
      result.push({
        name: `其他 (${rest.length})`,
        value: rest.reduce((sum, s) => sum + s.tokens, 0)
      })
    }
    return result
  })()

  // 柱状图数据格式化
  const barData = dailyStats.map(d => ({
    ...d,
    date: formatDate(d.date)
  }))

  return (
    <div className="space-y-3">
      {/* 汇总卡片 */}
      <div className="grid grid-cols-2 gap-2">
        <div className="p-2.5 rounded-lg bg-bg-primary border border-border">
          <div className="flex items-center gap-1.5 mb-1">
            <Zap className="w-3 h-3 text-accent-yellow" />
            <span className="text-[10px] text-text-muted">今日 Token</span>
          </div>
          <div className="text-base font-semibold text-accent-yellow">
            {formatTokens(summary?.todayTokens || 0)}
          </div>
        </div>
        <div className="p-2.5 rounded-lg bg-bg-primary border border-border">
          <div className="flex items-center gap-1.5 mb-1">
            <Clock className="w-3 h-3 text-accent-blue" />
            <span className="text-[10px] text-text-muted">今日时长</span>
          </div>
          <div className="text-base font-semibold text-accent-blue">
            {formatMinutes(summary?.todayMinutes || 0)}
          </div>
        </div>
        <div className="p-2.5 rounded-lg bg-bg-primary border border-border">
          <div className="flex items-center gap-1.5 mb-1">
            <TrendingUp className="w-3 h-3 text-accent-green" />
            <span className="text-[10px] text-text-muted">累计 Token</span>
          </div>
          <div className="text-base font-semibold text-accent-green">
            {formatTokens(summary?.totalTokens || 0)}
          </div>
        </div>
        <div className="p-2.5 rounded-lg bg-bg-primary border border-border">
          <div className="flex items-center gap-1.5 mb-1">
            <Clock className="w-3 h-3 text-accent-purple" />
            <span className="text-[10px] text-text-muted">累计时长</span>
          </div>
          <div className="text-base font-semibold text-accent-purple">
            {formatMinutes(summary?.totalMinutes || 0)}
          </div>
        </div>
      </div>

      {/* 每日 Token 趋势 */}
      {barData.length > 0 && (
        <div className="p-2.5 rounded-lg bg-bg-primary border border-border">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-text-muted">每日 Token 趋势 (30天)</span>
            <button
              onClick={fetchData}
              className="p-1 rounded hover:bg-bg-hover btn-transition text-text-muted"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={barData} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 9, fill: '#484F58' }}
                axisLine={{ stroke: '#30363D' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 9, fill: '#484F58' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={formatTokens}
              />
              <Tooltip content={<BarTooltip />} />
              <Bar dataKey="tokens" fill="#58A6FF" radius={[2, 2, 0, 0]} maxBarSize={20} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 会话用量分布（饼图） */}
      {pieData.length > 0 && (
        <div className="p-2.5 rounded-lg bg-bg-primary border border-border">
          <span className="text-[10px] text-text-muted">会话 Token 分布</span>
          <ResponsiveContainer width="100%" height={160}>
            <PieChart>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={30}
                outerRadius={55}
                paddingAngle={2}
                stroke="none"
              >
                {pieData.map((_entry, index) => (
                  <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(value: number) => formatTokens(value)}
                contentStyle={{
                  backgroundColor: '#161B22',
                  border: '1px solid #30363D',
                  borderRadius: '6px',
                  fontSize: '11px',
                  color: '#E6EDF3'
                }}
              />
              <Legend
                formatter={(value: string) => (
                  <span style={{ color: '#8B949E', fontSize: '10px' }}>{value}</span>
                )}
                iconSize={8}
                wrapperStyle={{ fontSize: '10px' }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 无数据时的占位 */}
      {barData.length === 0 && pieData.length === 0 && (
        <div className="text-center text-text-muted text-xs py-6">
          <Zap className="w-8 h-8 mx-auto mb-2 opacity-20" />
          <p>暂无用量数据</p>
          <p className="mt-1 text-[10px]">开始使用 Claude Code 会话后将自动记录</p>
        </div>
      )}
    </div>
  )
}
