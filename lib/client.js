window.__ModuleLoader__.load({
  id: 'dsh-timer-scheduler-ui',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')

    var CSS = [
      '.dsh-sched-panel{position:fixed;right:16px;bottom:128px;z-index:9999;pointer-events:auto;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,0.28);padding:12px 14px;max-width:320px;min-width:220px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary);}',
      '.dsh-sched-panel__title{font-weight:600;font-size:13px;margin-bottom:8px;}',
      '.dsh-sched-panel__list{display:flex;flex-direction:column;gap:8px;}',
      '.dsh-sched-panel__row{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '.dsh-sched-panel__grow{flex:1;min-width:0;}',
      '.dsh-sched-panel__note{font-size:13px;line-height:1.35;word-break:break-word;color:var(--dsw-alias-label-primary);}',
      '.dsh-sched-panel__meta{font-size:11px;margin-top:3px;color:var(--dsw-alias-label-secondary);}',
    ].join('')

    var CSS_ID = 'dsh-timer-scheduler-ui:panel'

    function ensureStyles() {
      if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') === null) {
        var tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-timer-scheduler-ui'
        tag.dataset.pluginCss = CSS_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
    }

    function fmt(ms) {
      var totalSec = Math.max(0, Math.floor(ms / 1000))
      var m = Math.floor(totalSec / 60)
      var s = totalSec % 60
      return m + ':' + (s < 10 ? '0' + s : String(s))
    }

    exports.inject = ['slots', 'timer', 'sessions']

    exports.apply = function (ctx) {
      ensureStyles()

      function ReminderPanel() {
        var remindersState = React.useState([])
        var reminders = remindersState[0]
        var setReminders = remindersState[1]
        var nowState = React.useState(Date.now())
        var now = nowState[0]
        var setNow = nowState[1]

        React.useEffect(function () {
          var alive = true
          function poll() {
            setNow(Date.now())
            var sessionId
            try {
              sessionId = ctx.sessions.list.getSnapshot().current
            } catch (e) {
              sessionId = undefined
            }
            if (!sessionId) return
            fetch('/api/timer-reminders?sessionId=' + encodeURIComponent(sessionId))
              .then(function (r) { return r.json() })
              .then(function (data) {
                if (!alive) return
                var list = data && Array.isArray(data.reminders) ? data.reminders : []
                setReminders(list)
              })
              .catch(function () { if (alive) setReminders([]) })
          }
          poll()
          var stop
          if (typeof ctx.interval === 'function') stop = ctx.interval(poll, 1000)
          else if (ctx.timer && typeof ctx.timer.interval === 'function') stop = ctx.timer.interval(poll, 1000)
          else stop = function () {}
          return function () { alive = false; stop() }
        }, [])

        if (reminders.length === 0) return null

        var rows = reminders.map(function (r) {
          var dueMs = typeof r.dueMs === 'number' ? r.dueMs : 0
          var remainMs = Math.max(0, dueMs - now)
          return React.createElement('div', { key: r.id, className: 'dsh-sched-panel__row' },
            React.createElement('div', { className: 'dsh-sched-panel__grow' },
              React.createElement('div', { className: 'dsh-sched-panel__note' }, r.note),
              React.createElement('div', { className: 'dsh-sched-panel__meta' }, '剩余 ' + fmt(remainMs)),
            ),
          )
        })

        return React.createElement('div', { className: 'dsh-sched-panel' },
          React.createElement('div', { className: 'dsh-sched-panel__title' }, '\u23F0 定时提醒'),
          React.createElement('div', { className: 'dsh-sched-panel__list' }, rows),
        )
      }

      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          { name: 'shell.overlay', id: 'timer-scheduler', order: 1000, label: '定时提醒' },
          function () { return React.createElement(ReminderPanel, null) },
        )
      })
    }

    return module.exports
  },
})
