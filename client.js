window.__ModuleLoader__.load({
  id: 'dsh-usage-strip',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const POLL_MS = 60_000
    const REFRESH_EVENT = 'dsh-usage-strip:refresh'

    const zh = (typeof navigator !== 'undefined' ? navigator.language : 'en')?.toLowerCase().startsWith('zh') === true
    const LABELS = zh
      ? { opencode: 'GO', kimi: 'Kimi', '5h': '5h', week: '周', month: '月', day: '日', '1h': '1h', code: '代码', failed: '读取失败', refresh: '点击刷新用量' }
      : { opencode: 'GO', kimi: 'Kimi', '5h': '5h', week: 'wk', month: 'mo', day: 'd', '1h': '1h', code: 'code', failed: 'unavailable', refresh: 'Click to refresh usage' }

    function labelOf(key) {
      return LABELS[key] ?? key
    }

    function resetText(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const time = date.toLocaleString(zh ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      return `${zh ? '重置于' : 'resets'} ${time}`
    }

    const palette = {
      ok: 'var(--dsw-alias-label-secondary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      high: 'var(--dsw-alias-state-error-primary)',
    }

    function tone(percent) {
      if (!Number.isFinite(percent)) return palette.ok
      if (percent >= 90) return palette.high
      if (percent >= 70) return palette.warn
      return palette.ok
    }

    function WindowValue({ window }) {
      const percent = Number(window?.percent)
      const shown = Number.isFinite(percent) ? `${Math.round(percent)}%` : '—'
      const parts = []
      const reset = resetText(window?.resetAt)
      if (Number.isFinite(percent)) parts.push(`${zh ? '已用' : 'used'} ${shown}`)
      if (window?.status === 'rate-limited') parts.push(zh ? '已限流' : 'rate-limited')
      if (reset.length > 0) parts.push(reset)
      return h('span', {
        title: parts.join(' · '),
        style: {
          color: tone(percent),
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        },
      }, `${labelOf(window?.key)} ${shown}`)
    }

    function Provider({ provider }) {
      const windows = Array.isArray(provider?.windows) ? provider.windows : []
      const failed = provider?.ok !== true
      return h('span', {
        style: { display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' },
      },
      h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, LABELS[provider?.id] ?? provider?.id),
      failed
        ? h('span', { title: typeof provider?.error === 'string' ? provider.error : '', style: { opacity: 0.7 } }, LABELS.failed)
        : windows.map((window, index) => h(React.Fragment, { key: `${window?.key}-${index}` },
          index > 0 ? h('span', { style: { opacity: 0.45 } }, ' · ') : null,
          h(WindowValue, { window }))),
      )
    }

    function UsageStrip() {
      const [data, setData] = React.useState(null)
      const [stale, setStale] = React.useState(false)

      const load = React.useCallback(async (force) => {
        try {
          const response = await fetch(`/usage-strip/usage${force ? '?force=1' : ''}`, {
            credentials: 'same-origin',
            cache: 'no-store',
          })
          if (!response.ok) throw new Error(`status ${response.status}`)
          const next = await response.json()
          if (next === null || typeof next !== 'object' || !Array.isArray(next.providers)) throw new Error('bad payload')
          setData(next)
          setStale(false)
        } catch {
          setStale(true)
        }
      }, [])

      React.useEffect(() => {
        let disposed = false
        const refresh = (force) => {
          if (!disposed) load(force)
        }
        refresh(false)
        const timer = window.setInterval(() => {
          if (document.visibilityState === 'visible') refresh(false)
        }, POLL_MS)
        const onVisible = () => {
          if (document.visibilityState === 'visible') refresh(false)
        }
        const onRefresh = () => refresh(true)
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener(REFRESH_EVENT, onRefresh)
        return () => {
          disposed = true
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
          window.removeEventListener(REFRESH_EVENT, onRefresh)
        }
      }, [load])

      const providers = (data?.providers ?? []).filter((provider) => provider && (provider.ok === true || provider.configured === true))
      if (providers.length === 0) return null

      return h('div', {
        role: 'status',
        'aria-live': 'off',
        title: LABELS.refresh,
        onClick: () => load(true),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 12,
          fontSize: 11,
          lineHeight: '16px',
          color: 'var(--dsw-alias-label-secondary)',
          cursor: 'pointer',
          userSelect: 'none',
          opacity: stale ? 0.55 : 1,
          transition: 'opacity 160ms ease',
        },
      }, providers.map((provider, index) => h(React.Fragment, { key: provider?.id ?? index },
        index > 0 ? h('span', { 'aria-hidden': true, style: { width: 1, height: 10, background: 'var(--dsw-alias-border-l1)' } }) : null,
        h(Provider, { provider }))))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'usage-strip',
          order: 2,
        }, UsageStrip))
      },
    }
  },
})
