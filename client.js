window.__ModuleLoader__.load({
  id: 'dsh-quoted',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ENDPOINT = '/api/dsh-quoted'
    const HEADER = 'x-dsh-quoted'
    const CHAT = '[data-chat-flow]'
    const EDITED = '[contenteditable="true"], [contenteditable=""], textarea, input'
    const OWN = '[data-dsh-quoted]'
    const MENU = 'dsh-quoted-menu'
    /**
     * Separator between the draft text and the annotation chip.
     *
     * ' ' keeps the sentence on one line. The host drops a space that sits directly
     * before a chip, so a reference typed against preceding text parses as plain text;
     * that is a host behaviour the plugin cannot change.
     */
    const SEPARATOR = ' '
    const DUPLICATE_MS = 3000

    /** Latest usable selection: { text, at, range }. */
    let selection = null
    /** Open context menu: { x, y, text, range } or null. */
    let menu = null
    /** Annotation asked for by the UI, consumed by the session component. */
    let request = null
    /** Marks painted over captured passages: [{ id, index, range, text }]. */
    let markers = []
    let markerSeq = 0
    /** True while an IME composition owns the editor; writing then would eat the text. */
    let composing = false
    let retryPending = false
    /** Last accepted capture, so a double click does not create a second file. */
    let lastDelivery = { text: '', at: 0 }
    const listeners = new Set()

    function notify() {
      for (const listener of [...listeners]) listener()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    function addMarker(range, text) {
      if (range === null || range === undefined) return
      markerSeq += 1
      markers = [...markers, { id: markerSeq, index: markers.length + 1, range, text }]
      notify()
    }

    function clearMarkers() {
      if (markers.length === 0) return
      markers = []
      markerSeq = 0
      notify()
    }

    function chinese() {
      try {
        return /^zh/i.test(navigator.language || '') || /^zh/i.test(document.documentElement.lang || '')
      } catch {
        return false
      }
    }

    function elementOf(node) {
      if (node === null || node === undefined) return null
      return node.nodeType === 1 ? node : node.parentElement
    }

    /** Selections we must not hijack: the composer, our own UI, and outside the transcript. */
    function inTranscript(element) {
      if (element === null || typeof element.closest !== 'function') return false
      if (element.closest(CHAT) !== null) return true
      // If the host stopped exposing the flow marker, stay permissive rather than dead.
      return typeof document.querySelector === 'function' && document.querySelector(CHAT) === null
    }

    function selectionText() {
      const current = typeof document.getSelection === 'function' ? document.getSelection() : null
      if (current === null || current.rangeCount === 0 || current.isCollapsed) return null
      const text = current.toString().trim()
      if (text === '') return null
      const element = elementOf(current.anchorNode)
      if (element === null || typeof element.closest !== 'function') return null
      if (element.closest(EDITED) !== null) return null
      if (element.closest(OWN) !== null) return null
      if (!inTranscript(element)) return null
      return text
    }

    function currentRange() {
      const current = typeof document.getSelection === 'function' ? document.getSelection() : null
      if (current === null || current.rangeCount === 0) return null
      try {
        return current.getRangeAt(0).cloneRange()
      } catch {
        return null
      }
    }

    function trackSelection() {
      const text = selectionText()
      if (text === null) return
      if (selection !== null && selection.text === text) return
      selection = { text, at: Date.now(), range: currentRange() }
      notify()
    }

    function openMenu(x, y, text, range) {
      menu = { x, y, text, range }
      notify()
    }

    function closeMenu() {
      if (menu === null) return
      menu = null
      notify()
    }

    function requestAnnotation(text, range) {
      if (text === '') return
      const now = Date.now()
      if (text === lastDelivery.text && now - lastDelivery.at < DUPLICATE_MS) return
      lastDelivery = { text, at: now }
      request = { text, at: now, range: range === undefined ? null : range }
      notify()
    }

    function takeRequest() {
      const next = request
      request = null
      return next
    }

    function copyText(text) {
      try {
        if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          void navigator.clipboard.writeText(text)
        }
      } catch {
        // The selection stays selected, so Ctrl+C still works when the clipboard API is refused.
      }
    }

    /** Human text for the failure codes the button can surface. */
    const FAILURE_TEXT = {
      'no-workspace': ['找不到工作区', 'no workspace found'],
      'no-draft': ['读不到输入框草稿', 'the composer draft is unavailable'],
      forbidden: ['请求被拒绝', 'request rejected'],
      'write-failed': ['写入注释文件失败', 'annotation file write failed'],
      network: ['网络请求失败', 'network request failed'],
      'http-error': ['服务返回异常', 'unexpected server response'],
    }

    function failureText(code, zh) {
      const entry = code === null || code === undefined ? undefined : FAILURE_TEXT[code]
      if (entry === undefined) return zh ? `未知原因（${code}）` : `unknown (${code})`
      return zh ? entry[0] : entry[1]
    }

    function clockOf(at) {
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    const itemStyle = {
      display: 'flex',
      alignItems: 'center',
      width: '100%',
      height: 30,
      padding: '0 10px',
      border: 'none',
      borderRadius: 6,
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, #111827)',
      font: 'inherit',
      fontSize: 13,
      textAlign: 'left',
      cursor: 'pointer',
    }

    /** Floating menu over the whole frame: replaces the native menu only for a transcript selection. */
    function AnnotationMenu() {
      const [version, setVersion] = React.useState(0)
      React.useEffect(() => subscribe(() => setVersion((value) => value + 1)), [])

      const open = menu !== null
      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const target = event.target
          if (target instanceof Element && target.closest(`.${MENU}`) !== null) return
          closeMenu()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') closeMenu()
        }
        const onDismiss = () => closeMenu()
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        window.addEventListener('scroll', onDismiss, true)
        window.addEventListener('resize', onDismiss)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
          window.removeEventListener('scroll', onDismiss, true)
          window.removeEventListener('resize', onDismiss)
        }
      }, [open])

      if (menu === null) return null
      const zh = chinese()
      const width = 148
      const height = 78
      const left = Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))
      const top = Math.max(8, Math.min(menu.y, window.innerHeight - height - 8))

      return h('div', {
        className: MENU,
        'data-dsh-quoted': 'menu',
        role: 'menu',
        style: {
          position: 'fixed',
          left,
          top,
          zIndex: 2147483000,
          minWidth: width,
          padding: 4,
          pointerEvents: 'auto',
          borderRadius: 10,
          background: 'var(--dsw-alias-bg-elevated, #ffffff)',
          border: '1px solid var(--dsw-alias-border-default, rgba(127, 127, 127, 0.25))',
          boxShadow: '0 8px 28px rgba(0, 0, 0, 0.18)',
        },
      },
      h('style', null, `.${MENU} button:hover{background:var(--dsw-alias-bg-hover, rgba(127, 127, 127, 0.12))}`),
      h('button', {
        type: 'button',
        role: 'menuitem',
        style: itemStyle,
        onClick: () => {
          const text = menu === null ? '' : menu.text
          closeMenu()
          copyText(text)
        },
      }, zh ? '复制' : 'Copy'),
      h('button', {
        type: 'button',
        role: 'menuitem',
        style: itemStyle,
        onClick: () => {
          const text = menu === null ? '' : menu.text
          const range = menu === null ? null : menu.range
          closeMenu()
          requestAnnotation(text, range)
        },
      }, zh ? '引用' : 'Quote'))
    }

    /**
     * Paints a mark over every captured passage: a CSS custom highlight on the text
     * plus a numbered badge at its end, so the user sees which part of the conversation
     * a pending annotation quotes, before sending.
     */
    function AnnotationMarks() {
      const [version, setVersion] = React.useState(0)
      React.useEffect(() => subscribe(() => setVersion((value) => value + 1)), [])

      const [tick, setTick] = React.useState(0)
      const has = markers.length > 0
      React.useEffect(() => {
        if (!has) return undefined
        let frame = 0
        const schedule = () => {
          if (frame !== 0) return
          frame = window.requestAnimationFrame(() => {
            frame = 0
            setTick((value) => value + 1)
          })
        }
        document.addEventListener('scroll', schedule, true)
        window.addEventListener('resize', schedule)
        return () => {
          if (frame !== 0) window.cancelAnimationFrame(frame)
          document.removeEventListener('scroll', schedule, true)
          window.removeEventListener('resize', schedule)
        }
      }, [has])

      React.useEffect(() => {
        const highlights = typeof CSS === 'undefined' ? undefined : CSS.highlights
        if (highlights === undefined || typeof Highlight === 'undefined') return undefined
        const highlight = new Highlight()
        for (const marker of markers) {
          try {
            if (marker.range !== null && marker.range.commonAncestorContainer.isConnected) highlight.add(marker.range)
          } catch {
            // A detached range cannot be painted.
          }
        }
        highlights.set('dsh-quoted', highlight)
        return () => {
          try {
            highlights.delete('dsh-quoted')
          } catch {
            // Nothing to remove.
          }
        }
      }, [version, tick])

      if (markers.length === 0) return null

      return h(React.Fragment, null,
        h('style', null, '::highlight(dsh-quoted){background-color:rgba(47,111,235,0.16)}'),
        markers.map((marker) => {
          let rect = null
          try {
            const rects = marker.range.getClientRects()
            rect = rects.length > 0 ? rects[rects.length - 1] : marker.range.getBoundingClientRect()
          } catch {
            rect = null
          }
          if (rect === null || (rect.width === 0 && rect.height === 0)) return null
          const size = 18
          const left = Math.max(2, Math.min(rect.right + 2, window.innerWidth - size - 2))
          const top = Math.max(2, rect.top - 6)
          return h('div', {
            key: marker.id,
            'data-dsh-quoted': 'mark',
            title: marker.text.length > 80 ? `${marker.text.slice(0, 80)}…` : marker.text,
            style: {
              position: 'fixed',
              left,
              top,
              width: size,
              height: size,
              zIndex: 2147482000,
              borderRadius: size / 2,
              background: '#2f6feb',
              color: '#ffffff',
              fontSize: 11,
              fontWeight: 600,
              lineHeight: `${size}px`,
              textAlign: 'center',
              boxShadow: '0 1px 4px rgba(0, 0, 0, 0.3)',
              pointerEvents: 'auto',
              userSelect: 'none',
            },
          }, String(marker.index))
        }))
    }

    /**
     * Session-scoped half: it owns the composer handle. A capture becomes a workspace
     * file plus a reference chip in the draft, so the quoted material stays a separate
     * node from what the user types.
     */
    function CaptureButton(props) {
      const inputActions = props.inputActions
      const sessionId = props.sessionId

      // The per-session snapshot carries UI state only; the workspace path lives on
      // the sessions list snapshot as `byId[id].cwd`.
      let fromList
      try {
        fromList = props.useSessions === undefined || sessionId === undefined
          ? undefined
          : props.useSessions((state) => (state === undefined || state === null || state.byId === undefined
            ? undefined
            : state.byId[sessionId]?.cwd))
      } catch {
        fromList = undefined
      }
      let fromSession
      try {
        const snapshot = props.useSession === undefined ? undefined : props.useSession((state) => state)
        fromSession = snapshot === null || snapshot === undefined ? undefined : snapshot.cwd
      } catch {
        fromSession = undefined
      }
      const directory = typeof fromList === 'string' && fromList !== ''
        ? fromList
        : (typeof fromSession === 'string' && fromSession !== '' ? fromSession : undefined)

      // The live draft gives us the text and the chips already in the composer, so a
      // rewrite keeps both instead of silently dropping the user's own references.
      let liveInput
      try {
        liveInput = props.useInput === undefined ? undefined : props.useInput((state) => state)
      } catch {
        liveInput = undefined
      }
      const draftText = liveInput !== null && liveInput !== undefined && typeof liveInput.draft === 'string'
        ? liveInput.draft
        : undefined
      const draftReferences = liveInput !== null && liveInput !== undefined && Array.isArray(liveInput.occurrences)
        ? liveInput.occurrences
        : undefined

      // Read at delivery time: a render may lag behind the last keystroke.
      const latest = React.useRef({ draft: undefined, references: undefined })
      React.useEffect(() => {
        latest.current = { draft: draftText, references: draftReferences }
      })

      // Marks mirror the annotation chips still attached to the draft: once they are
      // gone (sent, cleared, or removed by hand) the marks clear with them.
      const annotationChips = draftReferences === undefined
        ? undefined
        : draftReferences.filter((reference) => reference !== null
          && typeof reference === 'object'
          && typeof reference.ref === 'string'
          && reference.ref.indexOf('.dsh-annotations/') !== -1).length

      const [phase, setPhase] = React.useState('idle')
      const [failure, setFailure] = React.useState(null)
      const [, setVersion] = React.useState(0)
      const busy = React.useRef(false)
      // Guards the "back to idle" timer so a finished run cannot reset a newer one.
      const runSeq = React.useRef(0)

      const deliver = React.useCallback(async (next) => {
        const current = latest.current
        // Without the semantic draft there is no safe way to attach a reference: writing
        // the mention as plain text loses the separator, and the host then folds the
        // following sentence into the link. Fail instead of producing that.
        if (inputActions === undefined || current.draft === undefined || current.references === undefined) {
          setFailure('no-draft')
          return false
        }

        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [HEADER]: '1' },
          body: JSON.stringify({
            text: next.text,
            cwd: directory,
            sessionId,
            capturedAt: new Date(next.at).toISOString(),
          }),
        })
        const payload = await response.json().catch(() => null)
        if (payload === null || payload.ok !== true) {
          setFailure(payload !== null && typeof payload.error === 'string' ? payload.error : 'http-error')
          return false
        }

        const zh = chinese()
        const mention = `@${payload.relative}`
        const label = `${zh ? '注释' : 'Note'} ${clockOf(next.at)}`
        const glue = current.draft === '' || /\s$/u.test(current.draft) ? '' : SEPARATOR
        // The space after the chip must be a real text node: the host builds the stored
        // message from the editor text, not from the chip's clipboardText, so a space
        // carried inside the chip disappears and the sentence merges into the reference.
        const prefix = `${current.draft}${glue}`
        const text = `${prefix} `

        try {
          inputActions.setDraft({
            text,
            references: [
              ...current.references,
              {
                source: 'reference',
                ref: mention,
                offset: prefix.length,
                length: 0,
                label,
                clipboardText: mention,
                appearance: 'file',
              },
            ],
          })
        } catch {
          setFailure('no-draft')
          return false
        }
        return 'chip'
      }, [directory, inputActions, sessionId])

      const run = React.useCallback(async () => {
        if (busy.current) return
        // Writing during an IME composition would swallow the text being composed.
        if (composing) {
          if (!retryPending) {
            retryPending = true
            window.setTimeout(() => {
              retryPending = false
              void run()
            }, 150)
          }
          return
        }
        const next = takeRequest()
        if (next === null) return
        if (inputActions === undefined) {
          setPhase('failed')
          return
        }
        busy.current = true
        const seq = runSeq.current + 1
        runSeq.current = seq
        setFailure(null)
        setPhase('saving')

        let result = false
        try {
          result = await deliver(next)
        } catch (error) {
          setFailure('network')
          try {
            console.error('[dsh-quoted] deliver failed', error)
          } catch {
            // Console access is optional.
          }
        }

        if (result !== false) {
          selection = null
          addMarker(next.range, next.text)
        }
        setPhase(result === false ? 'failed' : result)
        busy.current = false
        notify()
        window.setTimeout(() => {
          if (runSeq.current === seq) setPhase('idle')
        }, 1800)
      }, [deliver, inputActions])

      React.useEffect(() => {
        const unsubscribe = subscribe(() => {
          void run()
        })
        void run()
        return unsubscribe
      }, [run])

      React.useEffect(() => subscribe(() => setVersion((value) => value + 1)), [])

      React.useEffect(() => {
        if (annotationChips !== 0) return
        if (markers.length === 0) return
        clearMarkers()
      }, [annotationChips])

      const zh = chinese()
      const idle = selection === null
      const disabled = idle || phase === 'saving' || inputActions === undefined

      const label = phase === 'saving'
        ? '…'
        : phase === 'chip'
          ? (zh ? '已引用' : 'Quoted')
          : phase === 'failed'
            ? (zh ? '失败' : 'Failed')
            : (zh ? '引用' : 'Quote')

      const title = inputActions === undefined
        ? (zh ? '当前会话没有可用的输入框' : 'The composer is unavailable in this session')
        : phase === 'failed'
          ? (zh ? `引用失败：${failureText(failure, zh)}` : `Quote failed: ${failureText(failure, zh)}`)
          : idle
            ? (zh ? '先在对话里选中一段文字，或在选中后点右键' : 'Select a passage in the conversation first')
            : (zh ? '把选中内容作为独立引用块附加到输入框' : 'Attach the selection to the composer as a separate quoted block')

      return h('button', {
        type: 'button',
        'data-dsh-quoted': 'capture',
        title,
        'aria-label': title,
        disabled,
        onClick: () => {
          if (selection === null) return
          requestAnnotation(selection.text, selection.range)
        },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          height: 28,
          padding: '0 8px',
          margin: 0,
          border: '1px solid var(--dsw-alias-border-default, rgba(127, 127, 127, 0.28))',
          borderRadius: 8,
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary, #6b7280)',
          font: 'inherit',
          fontSize: 12,
          lineHeight: 1,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled && idle ? 0.45 : 1,
        },
      }, label)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const onContextMenu = (event) => {
            const text = selectionText()
            if (text === null) return
            const range = currentRange()
            if (selection === null || selection.text !== text || selection.range === null) {
              selection = { text, at: Date.now(), range }
            }
            event.preventDefault()
            openMenu(event.clientX, event.clientY, text, range)
          }
          const onCompositionStart = () => {
            composing = true
          }
          const onCompositionEnd = () => {
            composing = false
          }
          document.addEventListener('selectionchange', trackSelection)
          document.addEventListener('mouseup', trackSelection)
          document.addEventListener('keyup', trackSelection)
          document.addEventListener('contextmenu', onContextMenu)
          document.addEventListener('compositionstart', onCompositionStart, true)
          document.addEventListener('compositionend', onCompositionEnd, true)
          return () => {
            document.removeEventListener('selectionchange', trackSelection)
            document.removeEventListener('mouseup', trackSelection)
            document.removeEventListener('keyup', trackSelection)
            document.removeEventListener('contextmenu', onContextMenu)
            document.removeEventListener('compositionstart', onCompositionStart, true)
            document.removeEventListener('compositionend', onCompositionEnd, true)
            listeners.clear()
          }
        })
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'annotation-capture',
          order: 30,
        }, CaptureButton))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'annotation-menu',
          order: 100,
        }, AnnotationMenu))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'annotation-marks',
          order: 101,
        }, AnnotationMarks))
      },
    }
  },
})
