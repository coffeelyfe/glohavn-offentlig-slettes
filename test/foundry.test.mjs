import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lagAdapter } from '../server/harnesses/foundry.mjs'

const rot = fs.mkdtempSync(path.join(os.tmpdir(), 'glohavn-'))
fs.mkdirSync(path.join(rot, 'apps', 'foundry'), { recursive: true })
fs.writeFileSync(path.join(rot, 'apps', 'foundry', 'bus.yml'), 'supabase:\n  url: https://bus.test\n  publishable_key: pk\n')
fs.writeFileSync(path.join(rot, 'apps', 'foundry', 'apper.yml'), 'apper:\n  borris:\n    navn: Borris\n    mappe: crossfit-app\n  einar-ai:\n    navn: Einar\n')
const naa = Date.parse('2026-11-09T12:00:00Z')
const T = (d) => new Date(naa - d * 3600e3).toISOString()
const data = {
  rom: [{ id: 'r1', type: 'app', nokkel: 'borris', tittel: 'Borris' }, { id: 'r2', type: 'oppgave', nokkel: 'einar-ai/127', tittel: 'Einar 127' }, { id: 'r3', type: 'app', nokkel: 'glor', tittel: 'Glør' }],
  foresporsler: [
    { id: 'f1', rom_id: 'r1', rolle: 'utvikler', status: 'tatt', tatt_av: 'claude', tatt_tid: T(1), opprettet: T(2) },
    { id: 'f2', rom_id: 'r2', rolle: 'utvikler', status: 'ferdig', ferdig_tid: T(5), opprettet: T(8) },
    { id: 'f3', rom_id: 'r3', rolle: 'glo', status: 'feilet', feil: 'tidsavbrudd', ferdig_tid: T(100), opprettet: T(101) },
  ],
  fremdrift: [{ foresporsel_id: 'f1', tid: T(0.5), type: 'verktoy', tekst: 'skriver koden' }, { foresporsel_id: 'f1', tid: T(0.8), type: 'start', tekst: '' }, { foresporsel_id: 'f2', tid: T(5), type: 'pr', tekst: 'PR #35' }],
  gjoremal: [{ rom_id: 'r1', app: 'borris', oppgave: '', tekst: 'Legg ut migrasjonen', laget: T(0.4) }],
  kjoringer: [{ app: 'einar-ai', oppgave: '127', utfall: 'merget', tid: T(4), lenke: 'https://github.com/x/pull/35' }],
  meldinger: [{ rom_id: 'r1', tid: T(2), fra: 'andreas', tekst: 'En app som gjør at Markus og jeg logger raskere', trenger_andreas: false }],
}
const fetchFn = async (url) => { const tabell = url.split('/rest/v1/')[1].split('?')[0]; return { ok: true, json: async () => data[tabell] || [] } }
const a = lagAdapter({ env: { FOUNDRY_ROT: rot, FOUNDRY_BUS_TOKEN: 'hemmelig', FOUNDRY_APPER_ROT: '/repoer' }, fetchFn, naa: () => naa })

test('oppdages når bus.yml og token finnes', async () => { assert.equal(await a.detect(), true); assert.equal(await lagAdapter({ env: {} }).detect(), false) })
test('forespørsler blir bots med riktig tilstand', async () => {
  const t = await a.scanThreads(); assert.equal(t.length, 3)
  const borris = t.find(x => x.ref.foresporsel === 'f1')
  assert.equal(borris.project, 'Borris'); assert.equal(borris.running, true); assert.equal(borris.unread, true); assert.equal(borris.projectPath, '/repoer/crossfit-app')
  assert.equal(borris.subagents.length, 1); assert.equal(borris.preview.startsWith('En app'), true)
  const einar = t.find(x => x.ref.foresporsel === 'f2'); assert.equal(einar.project, 'Einar'); assert.equal(einar.prState, 'merged'); assert.equal(einar.running, false)
  const glor = t.find(x => x.ref.foresporsel === 'f3'); assert.equal(glor.hasError, false, 'feil eldre enn tre døgn teller ikke'); assert.equal(glor.project, 'glor')
  assert.ok(t.every(x => x.id.startsWith('foundry:')))
})
test('åpne går til Glo', () => { assert.deepEqual(a.openThread({ rom: 'einar-ai/127' }), { ok: true, url: 'glo://rom/einar-ai%2F127' }); assert.equal(a.openThread(null).ok, false) })
