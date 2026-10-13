import type { ReactNode } from 'react'
import type { LinkStatus } from '../realtime/client.ts'
import { linkLive, linkTitle } from './airStatus.ts'

export function AirStatus(props: { link: LinkStatus }) {
  const { link } = props
  return (
    <>
      <Mark name="link" title={linkTitle(link.connection)} down={!linkLive(link.connection)}>
        <SignalMark />
      </Mark>
    </>
  )
}

function Mark(props: { name: string; title: string; down?: boolean; children: ReactNode }) {
  return (
    <span
      className={props.down ? 'air air-down' : 'air'}
      data-air={props.name}
      title={props.title}
      role="img"
      aria-label={props.title}
    >
      {props.children}
    </span>
  )
}

function Icon(props: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {props.children}
    </svg>
  )
}

function SignalMark() {
  return (
    <Icon>
      <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
      <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" />
      <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" />
      <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />
      <circle className="solid" cx="12" cy="12" r="2" />
    </Icon>
  )
}
