import type { ReactNode } from 'react'
import type { LinkStatus } from '../realtime/client.ts'
import { hostSpeaking, hostTitle, linkLive, linkTitle, micLive, micTitle } from './airStatus.ts'

export function AirStatus(props: { link: LinkStatus }) {
  const { link } = props
  return (
    <>
      <Mark name="link" title={linkTitle(link.connection)} down={!linkLive(link.connection)}>
        <SignalMark />
      </Mark>
      <Mark name="mic" title={micTitle(link.mic)}>
        {micLive(link.mic) ? <MicMark /> : <MicOffMark />}
      </Mark>
      <Mark name="host" title={hostTitle(link.host)}>
        {hostSpeaking(link.host) ? <SpeakingMark /> : <QuietMark />}
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

function MicMark() {
  return (
    <Icon>
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
      <path d="M19 11v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 19v2" />
      <path d="M9 21h6" />
    </Icon>
  )
}

function MicOffMark() {
  return (
    <Icon>
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
      <path d="M19 11v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 19v2" />
      <path d="M9 21h6" />
      <path d="M4 4 20 20" />
    </Icon>
  )
}

function QuietMark() {
  return (
    <Icon>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M6 19.5v-.8a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v.8" />
    </Icon>
  )
}

function SpeakingMark() {
  return (
    <Icon>
      <circle cx="8.2" cy="8.2" r="3" />
      <path d="M3.2 19.5v-.7a3.5 3.5 0 0 1 3.5-3.5h3a3.5 3.5 0 0 1 3.1 1.9" />
      <path d="M16.4 9.2a2.4 2.4 0 0 1 0 3.2" />
      <path d="M18.6 7.2a4.6 4.6 0 0 1 0 7.2" />
    </Icon>
  )
}
