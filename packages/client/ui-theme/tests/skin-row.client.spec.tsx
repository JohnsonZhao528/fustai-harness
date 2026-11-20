// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { allowAllAccess, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { SkinRow } from '../src/client/SkinRow.tsx'
import type { SkinRowComponentProps } from '../src/client/SkinRow.tsx'
import { createSkinRowStore } from '../src/client/settings-store.ts'
import type { ThemeSkin } from '../src/client/index.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)

const COPY: Record<string, string> = {
  'skin.title': 'Skin',
  'skin.a': 'Ink Paper',
  'skin.a.description': 'Warm paper · teal accent',
  'skin.b': 'Edge',
  'skin.b.description': 'Cool gray · lime accent',
  'skin.c': 'Air',
  'skin.c.description': 'Cream · terracotta accent',
}

function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  return bindSnapshotSelector(store)
}

type AttentionSnapshot = Parameters<Parameters<SkinRowComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: SkinRowComponentProps['useSessionStatus'] = selector => selector(noAttention)

function mount(skin: ThemeSkin = 'a') {
  // Real store instance — the sanctioned zero-machinery path for tests.
  const store = createSkinRowStore().create()
  store.actions.sync(skin, 0)
  const setSkin = vi.fn()
  const props: SkinRowComponentProps = {
    useSessions: emptySessions(),
    useSessionStatus,
    usePanelInfo, useSessionRetainInfo: () => undefined, useResource,
    useWorkspaces: emptyWorkspaces(),
    ...allowAllAccess,
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    setSkin,
  }
  render(<SkinRow {...props} />)
  return { store, setSkin }
}

const pressed = (name: RegExp): string | null =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed')

describe('SkinRow', () => {
  it('renders the title and three skin cards with the current skin selected', () => {
    mount('b')
    expect(screen.getByText('Skin')).toBeDefined()
    expect(pressed(/Ink Paper/)).toBe('false')
    expect(pressed(/Edge/)).toBe('true')
    expect(pressed(/Air/)).toBe('false')
  })

  it('click drives setSkin; selection follows the store mirror, not the click echo', () => {
    const b = mount('a')
    fireEvent.click(screen.getByRole('button', { name: /Air/ }))
    expect(b.setSkin).toHaveBeenCalledWith('c')
    // No store write yet: selection is unchanged.
    expect(pressed(/Ink Paper/)).toBe('true')
    act(() => { b.store.actions.sync('c', 1) })
    expect(pressed(/Air/)).toBe('true')
    expect(pressed(/Ink Paper/)).toBe('false')
  })
})
