/**
 * Call lifecycle:
 * connecting → active → ending → ended
 * (`awaiting_start` lives in the bridge's handshake, before a session exists.)
 */
export type CallState = 'connecting' | 'active' | 'ending' | 'ended';

export type CallEndReason =
  | 'agent-hangup'
  | 'caller-hangup'
  | 'transferred'
  | 'provider-failed'
  | 'max-duration'
  | 'idle-timeout'
  | 'bridge-closed'
  | 'error';
