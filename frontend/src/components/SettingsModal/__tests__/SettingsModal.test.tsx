import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/useAppStore'
import { SettingsModal } from '../SettingsModal'

describe('SettingsModal', () => {
  beforeEach(() => {
    useAppStore.setState({
      theme: 'dark',
      accentPalette: 'nexshell',
      uiFontFamily: "'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      uiFontSize: 12.5,
      borderRadius: 10,
    })
  })

  it('renders correctly when open and allows switching themes', () => {
    render(<SettingsModal open={true} onClose={() => {}} />)

    expect(screen.getByText('Appearance & Themes')).toBeDefined()
    expect(screen.getByText('Terminal')).toBeDefined()
    expect(screen.getByText('Paper')).toBeDefined()
    expect(screen.getByText('Editorial')).toBeDefined()

    fireEvent.click(screen.getByText('Terminal'))
    expect(useAppStore.getState().theme).toBe('terminal')

    fireEvent.click(screen.getByText('Paper'))
    expect(useAppStore.getState().theme).toBe('paper')

    fireEvent.click(screen.getByText('Editorial'))
    expect(useAppStore.getState().theme).toBe('editorial')
  })

  it('allows switching accent colors', () => {
    render(<SettingsModal open={true} onClose={() => {}} />)

    const amberBtn = screen.getByText('amber')
    fireEvent.click(amberBtn)
    expect(useAppStore.getState().accentPalette).toBe('amber')

    const emeraldBtn = screen.getByText('emerald')
    fireEvent.click(emeraldBtn)
    expect(useAppStore.getState().accentPalette).toBe('emerald')
  })
})
