import { expect, it } from 'vitest'

import { machineFileFrom, machineOtlpEndpoint } from '../src/index.ts'

const file = (text: string | null) => machineFileFrom('/h/config.yml', text)

it('reads the file, and the variable wins', () => {
  const written = file('telemetry:\n  otlp_endpoint: http://file:4318/v1/traces\n')
  expect(machineOtlpEndpoint({}, written)).toBe('http://file:4318/v1/traces')
  expect(machineOtlpEndpoint({ LINGTAI_TELEMETRY_OTLP_ENDPOINT: 'https://var/v1/traces' }, written)).toBe(
    'https://var/v1/traces',
  )
  expect(machineOtlpEndpoint({}, file(null))).toBeUndefined()
})

it.each([
  [{ LINGTAI_TELEMETRY_OTLP_ENDPOINT: 'not a url?token=secret' }, file(null), 'LINGTAI_TELEMETRY_OTLP_ENDPOINT'],
  [{}, file('telemetry:\n  otlp_endpoint: "not a url?token=secret"\n'), 'telemetry.otlp_endpoint'],
  [{}, file('telemetry:\n  otlp_endpoint: "ftp://u:secret@h/x?token=secret"\n'), 'telemetry.otlp_endpoint'],
])('refuses a bad value by name and never echoes it', (from, written, name) => {
  let message = ''
  try {
    machineOtlpEndpoint(from, written)
  } catch (err) {
    message = (err as Error).message
  }
  expect(message).toContain(name)
  for (const leak of ['secret', 'token', 'not a url', 'ftp://']) expect(message).not.toContain(leak)
})
