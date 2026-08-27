window.__ModuleLoader__.load({
  id: 'dsh-timer-scheduler-ui',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')

    var CSS = [
      '.dsh-sched-root{position:relative;display:inline-flex;}',
      '.dsh-sched-trigger{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:4px;padding:3px 6px;font-size:12px;line-height:18px;display:inline-flex;}',
      '.dsh-sched-trigger:hover,.dsh-sched-trigger:focus-visible{color:var(--dsw-alias-label-secondary);}',
      '.dsh-sched-count{margin:0 2px;}',
      '.dsh-sched-menu{z-index:9999;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);width:300px;max-width:min(300px,calc(100vw - 16px));max-height:min(320px,calc(100vh - 20px));box-shadow:var(--dsw-shadow-lv3);border-radius:12px;flex-direction:column;gap:1px;margin:0;padding:4px;list-style:none;display:flex;overflow:auto;position:fixed;}',
      '.dsh-sched-row{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary);border-radius:8px;align-items:flex-start;gap:8px;padding:6px 8px;font-size:12px;line-height:16px;display:flex;}',
      '.dsh-sched-grow{min-width:0;flex:1;}',
      '.dsh-sched-note{font-size:12px;line-height:1.35;word-break:break-word;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;}',
      '.dsh-sched-meta{font-size:11px;margin-top:3px;color:var(--dsw-alias-label-secondary);}',
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

      function ReminderAction() {
        var remindersState = React.useState([])
        var reminders = remindersState[0]
        var setReminders = remindersState[1]
        var nowState = React.useState(Date.now())
        var now = nowState[0]
        var setNow = nowState[1]
        var openState = React.useState(false)
        var open = openState[0]
        var setOpen = openState[1]
        var menuStyleState = React.useState(null)
        var menuStyle = menuStyleState[0]
        var setMenuStyle = menuStyleState[1]
        var rootRef = React.useRef(null)
        var buttonRef = React.useRef(null)

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

        React.useEffect(function () {
          if (!open) return
          function onDown(e) {
            var root = rootRef.current
            if (root && !root.contains(e.target)) setOpen(false)
          }
          document.addEventListener('mousedown', onDown)
          return function () { document.removeEventListener('mousedown', onDown) }
        }, [open])

        function toggle() {
          var next = !open
          setNow(Date.now())
          setOpen(next)
          if (next) {
            var btn = buttonRef.current
            if (btn) {
              var rect = btn.getBoundingClientRect()
              var width = 300
              var left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
              var top = rect.bottom + 5
              if (top + 320 > window.innerHeight) top = Math.max(8, rect.top - 320 - 5)
              setMenuStyle({ position: 'fixed', zIndex: 9999, top: top, left: left, width: width })
            } else {
              setMenuStyle({ position: 'fixed', zIndex: 9999, top: 8, left: 8, width: 300 })
            }
          }
        }

        if (reminders.length === 0) return null

        var rows = reminders.map(function (r) {
          var dueMs = typeof r.dueMs === 'number' ? r.dueMs : 0
          var remainMs = Math.max(0, dueMs - now)
          return React.createElement('li', { key: r.id, className: 'dsh-sched-row' },
            React.createElement('div', { className: 'dsh-sched-grow' },
              React.createElement('div', { className: 'dsh-sched-note' }, r.note),
              React.createElement('div', { className: 'dsh-sched-meta' }, '\u5269\u4f59 ' + fmt(remainMs)),
            ),
          )
        })

        return React.createElement('div', { ref: rootRef, className: 'dsh-sched-root' },
          React.createElement('button', {
            ref: buttonRef,
            type: 'button',
            className: 'dsh-sched-trigger',
            'aria-expanded': open,
            'aria-label': '\u5b9a\u65f6\u63d0\u9192',
            onClick: toggle,
          },
            React.createElement('span', null, reminders.length === 1 ? '1\u4e2a\u5b9a\u65f6\u542f\u52a8' : reminders.length + '\u4e2a\u5b9a\u65f6\u542f\u52a8'),
          ),
          open && menuStyle ? React.createElement('ul', { className: 'dsh-sched-menu', style: menuStyle, 'aria-label': '\u5b9a\u65f6\u63d0\u9192' }, rows) : null,
        )
      }

      ctx.slots.inject('conversation.session.header.actions', function () {
        return ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'timer-scheduler', order: 30, label: '\u5b9a\u65f6\u63d0\u9192' },
          function () { return React.createElement(ReminderAction, null) },
        )
      })
    }

    return module.exports
  },
})
