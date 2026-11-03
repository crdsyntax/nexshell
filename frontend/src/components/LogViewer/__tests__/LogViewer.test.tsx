import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LogViewer } from '../LogViewer'

const ANSI = [
  '\u001b[90mat Socket.emit (node:domain:489:12)\u001b[39m',
  '\u001b[32mSELECT id FROM reserva\u001b[39m',
  '\u001b[31mError: ER_BAD_FIELD_ERROR\u001b[39m',
].join('\n')

describe('LogViewer', () => {
  it('elimina los códigos ANSI y colorea por severidad', () => {
    render(<LogViewer text={ANSI} />)

    expect(screen.queryByText(/\[39m/)).toBeNull()
    expect(screen.queryByText(/\[32m/)).toBeNull()
    expect(screen.getByText('Error: ER_BAD_FIELD_ERROR').closest('.log-line')).toHaveClass(
      'is-error',
    )
    expect(
      screen.getByText('at Socket.emit (node:domain:489:12)').closest('.log-line'),
    ).toHaveClass('is-stack')
  })
})
