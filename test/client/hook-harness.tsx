/**
 * JSDOM-free interaction harness for the client views.
 *
 * The client half is SSR-tested under the node environment (no jsdom
 * dependency), but T5.1 needs real click / keyboard behaviour. Every panel view
 * is a plain function component whose only hook is `React.useState`, so this
 * test-only helper:
 *
 *  1. calls the component function directly with a stubbed `useState`
 *     (stored in a closure and kept across renders),
 *  2. renders the returned element tree with `react-dom/server` — the returned
 *     tree is already expanded, and every child component in the panel is
 *     hook-free, so this is a faithful static snapshot,
 *  3. exposes the element tree so tests can fire `onClick` / `onKeyDown`
 *     handlers and re-render with the accumulated state.
 *
 * The stub is installed only while the component function runs and restored in
 * a `finally`, and the node test runner isolates files, so other tests keep the
 * real React dispatcher. If a view starts using another hook, mount it through
 * React DOM instead of this harness.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

type HookComponent<P> = (props: P) => React.ReactElement

export interface MountedView<P> {
  props: P
  tree: React.ReactElement
  html: string
  /** Re-invoke the component with the state accumulated so far. */
  render(props?: P): MountedView<P>
}

export function mountWithHooks<P>(component: HookComponent<P>, initialProps: P): MountedView<P> {
  const slots: { value: unknown }[] = []
  let cursor = 0
  const useState = <S,>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] => {
    const index = cursor
    cursor += 1
    if (slots[index] === undefined) {
      slots[index] = { value: typeof initial === 'function' ? (initial as () => S)() : initial }
    }
    const slot = slots[index]!
    return [
      slot.value as S,
      (next) => {
        slot.value = typeof next === 'function' ? (next as (prev: S) => S)(slot.value as S) : next
      },
    ]
  }
  const reactWithHooks = React as unknown as { useState: unknown }
  const originalUseState = reactWithHooks.useState
  const invoke = (props: P): React.ReactElement => {
    cursor = 0
    reactWithHooks.useState = useState
    try {
      return component(props)
    } finally {
      reactWithHooks.useState = originalUseState
    }
  }
  const view: MountedView<P> = {
    props: initialProps,
    tree: invoke(initialProps),
    html: '',
    render(props = view.props) {
      view.props = props
      view.tree = invoke(props)
      view.html = renderToStaticMarkup(view.tree)
      return view
    },
  }
  return view.render()
}

/** Render one element tree to static HTML. */
export function htmlOf(tree: React.ReactNode): string {
  return renderToStaticMarkup(tree as React.ReactElement)
}

/**
 * Depth-first search over a React element tree, expanding hook-free function
 * components (and their children) so handlers on nested elements are reachable.
 */
export function findElement(
  root: React.ReactNode,
  predicate: (element: React.ReactElement) => boolean,
): React.ReactElement | undefined {
  const walk = (node: React.ReactNode): React.ReactElement | undefined => {
    if (node === null || node === undefined || typeof node === 'boolean') return undefined
    if (typeof node === 'string' || typeof node === 'number') return undefined
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = walk(child)
        if (found !== undefined) return found
      }
      return undefined
    }
    if (!React.isValidElement(node)) return undefined
    const element = node as React.ReactElement
    if (predicate(element)) return element
    const props = element.props as Record<string, unknown>
    const fromChildren = walk(props.children as React.ReactNode)
    if (fromChildren !== undefined) return fromChildren
    if (typeof element.type === 'function') {
      const component = element.type as (p: Record<string, unknown>) => React.ReactNode
      return walk(component(props) as React.ReactNode)
    }
    return undefined
  }
  return walk(root)
}

/** Find the first element whose `data-*` attribute matches `value`. */
export function findByData(
  root: React.ReactNode,
  attribute: string,
  value: string,
): React.ReactElement | undefined {
  return findElement(root, (element) => {
    const props = element.props as Record<string, unknown>
    return props[attribute] === value
  })
}

/** Invoke an element's click handler (throws when the element is not clickable). */
export function click(element: React.ReactElement): void {
  const onClick = (element.props as { onClick?: () => void }).onClick
  if (typeof onClick !== 'function') throw new Error('element has no onClick handler')
  onClick()
}

/**
 * Invoke an element's keydown handler. Returns whether `preventDefault` was
 * called (Space must be prevented to stop the panel from scrolling).
 */
export function pressKey(element: React.ReactElement, key: string): { prevented: boolean } {
  const onKeyDown = (element.props as { onKeyDown?: (event: unknown) => void }).onKeyDown
  if (typeof onKeyDown !== 'function') throw new Error('element has no onKeyDown handler')
  let prevented = false
  onKeyDown({
    key,
    preventDefault: () => {
      prevented = true
    },
    stopPropagation: () => {},
  })
  return { prevented }
}
