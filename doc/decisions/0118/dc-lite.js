/*
 * The smallest runtime that opens the 0118 mockups in a browser.
 *
 * The pages were drawn on a design canvas whose runtime is not in this
 * repository, so this reads the same markup: one <x-dc>, a <helmet>, {{path}}
 * holes, <sc-for list as>, <sc-if value>, on* handlers, and a
 * `class Component extends DCLogic` with renderVals(), state and setState().
 * Nothing else is supported, and nothing else is needed by these six files.
 */
;(() => {
  class DCLogic {
    constructor(props) {
      this.props = props
      this.state = {}
    }
    setState(patch) {
      this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch)
      this.__render()
    }
    forceUpdate() {
      this.__render()
    }
  }

  const HOLE = /\{\{\s*([^}]+?)\s*\}\}/g
  const WHOLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/

  function lookup(path, scopes) {
    if (path === 'true') return true
    if (path === 'false') return false
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path)
    if (/^(['"]).*\1$/.test(path)) return path.slice(1, -1)
    const [head, ...rest] = path.split('.')
    for (const scope of scopes) {
      if (scope && head in scope) return rest.reduce((v, k) => (v == null ? v : v[k]), scope[head])
    }
    return undefined
  }

  const text = (s, scopes) =>
    s.replace(HOLE, (_, p) => {
      const v = lookup(p, scopes)
      return v == null ? '' : String(v)
    })

  function build(node, scopes, out) {
    if (node.nodeType === Node.TEXT_NODE) {
      out.appendChild(document.createTextNode(text(node.nodeValue, scopes)))
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const tag = node.tagName.toLowerCase()
    if (tag === 'helmet') return
    if (tag === 'sc-for') {
      const list = lookup(node.getAttribute('list').match(WHOLE)[1], scopes) || []
      const as = node.getAttribute('as')
      list.forEach((item, i) => {
        const scope = { [as]: item, $index: i }
        for (const child of node.childNodes) build(child, [scope, ...scopes], out)
      })
      return
    }
    if (tag === 'sc-if') {
      if (lookup(node.getAttribute('value').match(WHOLE)[1], scopes)) {
        for (const child of node.childNodes) build(child, scopes, out)
      }
      return
    }
    const el = document.createElement(tag)
    let value = null
    for (const { name, value: raw } of node.attributes) {
      if (name.startsWith('hint-')) continue
      const whole = raw.match(WHOLE)
      if (name.startsWith('on') && whole) {
        const fn = lookup(whole[1], scopes)
        if (typeof fn === 'function') el.addEventListener(name.slice(2).toLowerCase(), fn)
        continue
      }
      const v = whole ? lookup(whole[1], scopes) : text(raw, scopes)
      if (name === 'value') value = v
      else if (v !== false && v != null) el.setAttribute(name, v === true ? '' : String(v))
    }
    for (const child of node.childNodes) build(child, scopes, el)
    if (value != null) {
      if (tag === 'textarea') el.textContent = String(value)
      el.value = String(value)
      el.setAttribute('value', String(value))
    }
    out.appendChild(el)
  }

  function mount() {
    const host = document.querySelector('x-dc')
    const script = document.querySelector('script[data-dc-script]')
    if (!host || !script) return
    for (const h of host.querySelectorAll('helmet')) {
      while (h.firstElementChild) document.head.appendChild(h.firstElementChild)
    }
    const template = host.cloneNode(true)
    const decl = JSON.parse(script.getAttribute('data-props') || '{}')
    const props = {}
    for (const [k, d] of Object.entries(decl)) if (!k.startsWith('$') && d && 'default' in d) props[k] = d.default
    const Component = new Function('DCLogic', `${script.textContent}\nreturn Component;`)(DCLogic)
    const c = new Component(props)
    c.__render = () => {
      const active = document.activeElement && document.activeElement.id
      const at = active ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null
      const frag = document.createDocumentFragment()
      for (const child of template.childNodes) build(child, [c.renderVals() || {}], frag)
      host.replaceChildren(frag)
      if (active) {
        const again = document.getElementById(active)
        if (again) {
          again.focus()
          if (at && again.setSelectionRange) again.setSelectionRange(at[0], at[1])
        }
      }
    }
    c.__render()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
})()
